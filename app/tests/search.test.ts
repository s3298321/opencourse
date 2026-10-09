import { describe, expect, it } from 'vitest'
import { searchCourse } from '@core/search'
import { fixtureCourseDir, loadCourse } from './helpers/courses'

const course = loadCourse(fixtureCourseDir('python-asyncio'))

describe('searchCourse', () => {
  it('ignores queries that are too short', () => {
    expect(searchCourse(course, 'a')).toEqual([])
    expect(searchCourse(course, '   ')).toEqual([])
  })

  it('matches lesson titles without an excerpt', () => {
    const hits = searchCourse(course, 'cancellation')
    expect(hits[0].lessonId).toBe('cancellation-and-timeouts')
    expect(hits[0].excerpt).toBeUndefined()
  })

  it('matches body text and returns a readable excerpt', () => {
    const hits = searchCourse(course, 'high-water mark')
    expect(hits.map((h) => h.lessonId)).toContain('streams-and-subprocess')
    const hit = hits.find((h) => h.lessonId === 'streams-and-subprocess')!
    expect(hit.excerpt).toBeTruthy()
    expect(hit.excerpt!.startsWith('#')).toBe(false)
    expect(hit.excerpt!.length).toBeLessThanOrEqual(120)
  })

  it('is case-insensitive', () => {
    expect(searchCourse(course, 'TASKGROUP').length).toBeGreaterThan(0)
  })

  it('returns at most one hit per lesson, capped', () => {
    const hits = searchCourse(course, 'async', 5)
    expect(hits.length).toBeLessThanOrEqual(5)
    expect(new Set(hits.map((h) => `${h.moduleId}/${h.lessonId}`)).size).toBe(hits.length)
  })

  it('finds nothing for a term the course does not use', () => {
    expect(searchCourse(course, 'kubernetes')).toEqual([])
  })
})
