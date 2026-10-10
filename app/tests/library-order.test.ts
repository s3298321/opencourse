import { describe, expect, it } from 'vitest'
import type { CourseSummary } from '../src/core/types'
import { compareLibraryCourses, courseStatus } from '../src/renderer/library-courses'

const course = (title: string, progressPercent = 0, lastOpenedAt?: string): CourseSummary => ({ courseId: title, slug: title, title, lessonCount: 1, projectCount: 0, progressPercent, lastOpenedAt })

describe('library ordering', () => {
  it('sorts by status, recency within started and completed courses, then title', () => {
    const list = [course('Z completed', 100, '2026-10-09'), course('B not started', 0, '2026-10-10'), course('A started', 50), course('A not started'), course('B started', 20, '2026-10-01'), course('A completed', 100, '2026-10-01')]
    expect(list.sort(compareLibraryCourses).map(item => item.title)).toEqual(['B started', 'A started', 'A not started', 'B not started', 'Z completed', 'A completed'])
  })
  it('uses explicit status for zero completion and rounded percentages, and tolerates missing or invalid timestamps', () => {
    expect(courseStatus({ ...course('Started'), progressStatus: 'in-progress' })).toBe('in-progress')
    expect(courseStatus({ ...course('Almost done', 100), progressStatus: 'in-progress' })).toBe('in-progress')
    expect([course('B', 10, 'invalid'), course('A', 10)].sort(compareLibraryCourses).map(item => item.title)).toEqual(['A', 'B'])
  })
})
