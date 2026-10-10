import { describe, expect, it } from 'vitest'
import { buildCourse } from '../src/core/manifest'
import { runCourseReadingTool } from '../src/main/course-reading'
import { projectCourse } from './helpers/project'
import type { ReadingSource } from '../src/core/types'

describe('course retrieval', () => {
  it('searches beyond the automatic lesson limit without exposing quiz answers', () => {
    const manifest = projectCourse(), module = manifest.modules[0]!
    if (module.type === 'project') throw new Error('Expected a lesson fixture')
    module.lessons[0]!.blocks = [
      { type: 'markdown', slug: 'long', content: 'Ordinary lesson text. '.repeat(2000) + 'TAIL_NEEDLE' },
      { type: 'quiz', slug: 'quiz', id: 'quiz', kind: 'single', question: 'PUBLIC_QUESTION', options: [{ id: 'a', text: 'PUBLIC_OPTION', correct: true }], explanation: 'HIDDEN_ANSWER' }
    ]
    const course = buildCourse(manifest, '/unused', undefined, 'local-course')
    const budget = { chars: 0, signal: new AbortController().signal }, sources: ReadingSource[] = []
    const query = (text: string) => JSON.parse(runCourseReadingTool(course, 'search_course', { query: text, cursor: 0 }, budget, sources))
    expect(query('TAIL_NEEDLE').hits[0]).toMatchObject({ lessonId: 'intro', moduleId: 'before' })
    expect(query('PUBLIC_QUESTION').hits).toHaveLength(1)
    expect(query('HIDDEN_ANSWER').hits).toEqual([])
    const first = JSON.parse(runCourseReadingTool(course, 'read_course_section', { module_id: 'before', lesson_id: 'intro', offset: 0 }, budget, sources))
    expect(first.text.length).toBeLessThanOrEqual(8000)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(sources).toContainEqual({ kind: 'course', courseId: 'local-course', moduleId: 'before', lessonId: 'intro', title: 'Before / Introduction' })
  })
  it('lists and reads projects, validates membership and stops aborted retrieval', () => {
    const course = buildCourse(projectCourse(), '/unused', undefined, 'local-course')
    const controller = new AbortController(), budget = { chars: 0, signal: controller.signal }
    const list = JSON.parse(runCourseReadingTool(course, 'list_course_sections', { cursor: 0 }, budget, []))
    expect(list.sections).toHaveLength(3)
    const project = JSON.parse(runCourseReadingTool(course, 'read_course_section', { module_id: 'portfolio-project', lesson_id: null, offset: 0 }, budget, []))
    expect(project.text).toContain('Acceptance criteria')
    expect(() => runCourseReadingTool(course, 'read_course_section', { module_id: 'other-course', lesson_id: null, offset: 0 }, budget, [])).toThrow('not in this course')
    controller.abort()
    expect(() => runCourseReadingTool(course, 'list_course_sections', { cursor: 0 }, budget, [])).toThrow('stopped')
  })
})
