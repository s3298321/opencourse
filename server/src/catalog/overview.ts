/**
 * What the catalog knows about a version, derived once at publish and stored
 * as JSON beside it: titles, counts and the author's own descriptive fields.
 *
 * It is built by reading only what a learner may see before adding the course.
 * Quiz options, answers, explanations, exercise solutions, tests, hints and
 * flashcard answers never enter it - the overview is served to anyone, and a
 * catalog that leaks the answer key ruins the course for everyone who adds it.
 */
import type { CourseManifest } from '@core/types'
import type { OutlineModule } from '@core/catalog/api'

export interface StoredOverview {
  slug: string
  title: string
  description?: string
  subject?: string
  difficulty?: CourseManifest['difficulty']
  estimatedHours?: number
  author?: string
  tags: string[]
  prerequisites: string[]
  outline: OutlineModule[]
  totalMinutes: number
  lessonCount: number
  projectCount: number
  quizCount: number
  exerciseCount: number
  flashcardCount: number
  hasCover: boolean
}

export function overviewOf(manifest: CourseManifest, hasCover: boolean): StoredOverview {
  let totalMinutes = 0, lessonCount = 0, projectCount = 0, quizCount = 0, exerciseCount = 0, flashcardCount = 0
  const outline: OutlineModule[] = manifest.modules.map((mod) => {
    if (mod.type === 'project') {
      projectCount++
      totalMinutes += mod.project.estimated_minutes ?? 0
      return { title: mod.title, kind: 'project', lessons: [] }
    }
    return {
      title: mod.title,
      kind: 'lessons',
      lessons: mod.lessons.map((lesson) => {
        lessonCount++
        totalMinutes += lesson.estimated_minutes ?? 0
        flashcardCount += lesson.flashcards?.length ?? 0
        for (const block of lesson.blocks) {
          if (block.type === 'quiz') quizCount++
          if (block.type === 'exercise') exerciseCount++
        }
        return lesson.estimated_minutes ? { title: lesson.title, minutes: lesson.estimated_minutes } : { title: lesson.title }
      })
    }
  })
  return {
    slug: manifest.slug,
    title: manifest.title,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.subject ? { subject: manifest.subject } : {}),
    ...(manifest.difficulty ? { difficulty: manifest.difficulty } : {}),
    ...(manifest.estimated_hours !== undefined ? { estimatedHours: manifest.estimated_hours } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    tags: normalizeTags(manifest.tags ?? []),
    prerequisites: manifest.prerequisites ?? [],
    outline, totalMinutes, lessonCount, projectCount, quizCount, exerciseCount, flashcardCount, hasCover
  }
}

/** Tags are matched case-insensitively and shown as their first spelling. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag)
    if (seen.size >= 20) break
  }
  return [...seen.values()]
}

export function searchFields(overview: StoredOverview, publisher: string): Record<'title' | 'description' | 'subject' | 'author' | 'publisher' | 'tags' | 'outline', string> {
  return {
    title: overview.title,
    description: overview.description ?? '',
    subject: overview.subject ?? '',
    author: overview.author ?? '',
    publisher,
    tags: overview.tags.join(' '),
    outline: overview.outline.flatMap((m) => [m.title, ...m.lessons.map((l) => l.title)]).join(' ')
  }
}
