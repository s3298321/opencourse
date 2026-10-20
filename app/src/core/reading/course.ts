import type { Course, ReadingSource } from '../types'
import { lessonContextText } from '../sidechat/context'
import { projectContextText } from '../projects/context'
import {
  boundedResult,
  MAX_RETRIEVAL_CHARS,
  nonnegativeInteger,
  searchQuery,
  toolArguments,
  type RetrievalBudget
} from '../reading/tools'

interface Section {
  moduleId: string
  lessonId: string | null
  title: string
  text: () => string
}
function sections(course: Course): Section[] {
  return course.modules.flatMap<Section>((module) =>
    module.type === 'project'
      ? [
          {
            moduleId: module.slug,
            lessonId: null,
            title: module.title,
            text: () => projectContextText(course.title, module)
          }
        ]
      : module.lessons.map((lesson) => ({
          moduleId: module.slug,
          lessonId: lesson.slug,
          title: `${module.title} / ${lesson.title}`,
          text: () => lessonContextText(course.title, module.title, lesson, course.subject, Number.MAX_SAFE_INTEGER)
        }))
  )
}
export function runCourseReadingTool(
  course: Course,
  name: string,
  raw: unknown,
  budget: RetrievalBudget,
  sources: ReadingSource[]
): string {
  const args = toolArguments(raw),
    all = sections(course)
  const source = (section: Section): ReadingSource => ({
    kind: 'course',
    courseId: course.courseId,
    moduleId: section.moduleId,
    ...(section.lessonId ? { lessonId: section.lessonId } : {}),
    title: section.title
  })
  const record = (section: Section): string => {
    const ref = source(section)
    if (!sources.some((item) => JSON.stringify(item) === JSON.stringify(ref))) sources.push(ref)
    return section.title
  }
  if (name === 'list_course_sections') {
    const cursor = nonnegativeInteger(args.cursor),
      entries = all.slice(cursor, cursor + 30)
    return boundedResult(
      {
        sections: entries.map(({ text: _text, ...entry }) => entry),
        nextCursor: cursor + entries.length < all.length ? cursor + entries.length : null
      },
      budget
    )
  }
  if (name === 'search_course') {
    const words = searchQuery(args.query).toLocaleLowerCase().split(/\s+/),
      cursor = nonnegativeInteger(args.cursor)
    const matches = all.flatMap((section) => {
      const text = section.text(),
        lower = text.toLocaleLowerCase()
      if (!words.every((word) => lower.includes(word))) return []
      const start = Math.max(0, lower.indexOf(words[0]!) - 160)
      return [{ section, excerpt: text.slice(start, start + 600) }]
    })
    const hits = matches.slice(cursor, cursor + 8).map(({ section, excerpt }) => ({
      moduleId: section.moduleId,
      lessonId: section.lessonId,
      source: record(section),
      excerpt
    }))
    return boundedResult(
      { hits, nextCursor: cursor + hits.length < matches.length ? cursor + hits.length : null },
      budget
    )
  }
  if (name === 'read_course_section') {
    const section = all.find((item) => item.moduleId === args.module_id && item.lessonId === args.lesson_id)
    if (!section) throw new Error('That section is not in this course.')
    const offset = nonnegativeInteger(args.offset),
      text = section.text(),
      excerpt = text.slice(offset, offset + MAX_RETRIEVAL_CHARS - 1000)
    return boundedResult(
      {
        source: record(section),
        text: excerpt,
        nextOffset: offset + excerpt.length < text.length ? offset + excerpt.length : null
      },
      budget
    )
  }
  throw new Error('Unknown course retrieval tool.')
}
