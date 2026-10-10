import type { CourseProgressStatus, CourseSummary } from '@core/types'

export function courseStatus(course: CourseSummary): CourseProgressStatus {
  return course.progressStatus ?? ((course.progressPercent ?? 0) >= 100 ? 'completed' : (course.progressPercent ?? 0) > 0 ? 'in-progress' : 'not-started')
}

const order: Record<CourseProgressStatus, number> = { 'in-progress': 0, 'not-started': 1, completed: 2 }
const openedAt = (course: CourseSummary): number => Date.parse(course.lastOpenedAt ?? '') || 0

export function compareLibraryCourses(a: CourseSummary, b: CourseSummary): number {
  const status = courseStatus(a)
  const group = order[status] - order[courseStatus(b)]
  if (group) return group
  if (status !== 'not-started') {
    const recency = openedAt(b) - openedAt(a)
    if (recency) return recency
  }
  return a.title.localeCompare(b.title) || a.courseId.localeCompare(b.courseId)
}
