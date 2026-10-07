/** Search authored course text; workspace files are not indexed here. */
import type { CourseView } from './types'
export interface SearchHit {
  kind: 'lesson' | 'project'
  moduleId: string
  lessonId?: string
  moduleTitle: string
  lessonTitle: string
  excerpt?: string
}
export const MIN_QUERY = 2
export const MAX_HITS = 20
export function searchCourse(course: CourseView, term: string, limit = MAX_HITS): SearchHit[] {
  const needle = term.trim().toLowerCase()
  if (needle.length < MIN_QUERY) return []
  const hits: SearchHit[] = []
  for (const mod of course.modules) {
    if (mod.type === 'project') {
      const text = [mod.project.definition, ...mod.project.requirements.map((r) => r.description), ...mod.project.deliverables.flatMap((d) => [d.title, d.description, ...d.acceptance_criteria])]
      const line = text.flatMap((t) => t.split('\n')).find((l) => l.toLowerCase().includes(needle))
      if (mod.title.toLowerCase().includes(needle) || line) hits.push({ kind: 'project', moduleId: mod.slug, moduleTitle: mod.title, lessonTitle: mod.title, excerpt: line?.slice(0, 120) })
      continue
    }
    for (const lesson of mod.lessons) {
      const base: SearchHit = { kind: 'lesson', moduleId: mod.slug, lessonId: lesson.slug, moduleTitle: mod.title, lessonTitle: lesson.title }
      if (lesson.title.toLowerCase().includes(needle)) { hits.push(base); continue }
      const line = lesson.blocks.flatMap((b) => b.type === 'markdown' ? b.content.split('\n') : []).find((l) => l.toLowerCase().includes(needle))
      if (line) hits.push({ ...base, excerpt: line.replace(/^[#>\-*\s]+/, '').slice(0, 120) })
    }
  }
  return hits.slice(0, limit)
}
