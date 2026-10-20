import { call } from './api'
import type { LearningClient } from '../../../../app/src/learning-ui/client'
import type { LearningState } from '@core/learning/types'
import type { CourseView, LearnerFlashcard, ReviewSummary } from '@core/types'
import { deserializeCard, summarizeReview, type ReviewCandidate, type StoredCard } from '@core/review'
export const learningClient: LearningClient = {
  request: (path, method = 'GET', body) => call(method, path, body),
  events: (id, refresh) => {
    const events = new EventSource(`/api/v1/learning/chats/${id}/events`)
    events.onmessage = (event) => {
      refresh()
      if (JSON.parse(event.data).type === 'done') events.close()
    }
    events.onerror = () => events.close()
    return () => events.close()
  }
}

/** A course in My learning, as the reader, the overview and review all load it. */
export interface EnrolledCourse {
  state: LearningState
  course: CourseView
  /** A newer published version, when there is one. */
  update: string | null
}

export async function loadEnrolledCourse(id: string): Promise<EnrolledCourse> {
  const library = await call<{ items: LearningState[] }>('GET', '/me/learning'),
    enrolled = library.items.find((s) => s.enrollment.kind === 'course' && s.enrollment.id === id)
  if (!enrolled) throw new Error('Add this course to My learning first.')
  const version = enrolled.enrollment.version
  const [result, latest] = await Promise.all([
    call<{ state: LearningState; course: CourseView }>('GET', `/learn/course/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
    call<{ version: string }>('GET', `/courses/${encodeURIComponent(id)}`).catch(() => null)
  ])
  return { state: result.state, course: result.course, update: latest && latest.version !== version ? latest.version : null }
}

export const lessonDone = (state: LearningState, lessonId: string): boolean => state.fields[`lesson:${lessonId}`]?.value === true
const completed = (value: unknown): boolean => Boolean((value as { completedAt?: string } | null)?.completedAt)

/** The app's progress summary, read from the synced fields instead of a progress file. */
export function courseSummary(course: CourseView, state: LearningState) {
  const f = state.fields
  const lessonsDone = course.flatLessons.filter((l) => lessonDone(state, l.lessonId)).length
  const projects = course.flatItems.filter((i) => i.kind === 'project').map((i) => i.moduleId)
  const projectsDone = projects.filter((id) => completed(f[`project:${id}`]?.value)).length
  return {
    lessonsDone, lessonsTotal: course.flatLessons.length,
    quizzesCorrect: course.quizIds.filter((id) => (f[`quiz:${id}`]?.value as { isCorrect?: boolean } | null)?.isCorrect).length,
    quizzesTotal: course.quizIds.length,
    exercisesDone: course.exerciseIds.filter((id) => completed(f[`exercise:${id}`]?.value)).length,
    exercisesTotal: course.exerciseIds.length,
    projectsDone, projectsTotal: projects.length,
    percent: course.flatItems.length ? Math.round(((lessonsDone + projectsDone) / course.flatItems.length) * 100) : 0
  }
}

/** Where Continue goes: the last item opened, or the first. */
export function resumeIndex(course: CourseView, state: LearningState): number {
  const last = state.fields.lastItem?.value as { kind?: string; moduleId?: string; lessonId?: string } | undefined
  const index = course.flatItems.findIndex((i) => i.moduleId === last?.moduleId && (i.kind === 'project' || i.lessonId === last?.lessonId))
  return Math.max(0, index)
}

export interface WebReviewCard extends ReviewCandidate {
  card: LearnerFlashcard
  lessonTitle: string
}

/** Every flashcard in course order; a card is eligible once its lesson is completed, as in the app. */
export function reviewCandidates(course: CourseView, state: LearningState): WebReviewCard[] {
  const cards: WebReviewCard[] = []
  for (const module of course.modules) {
    if (module.type === 'project') continue
    for (const lesson of module.lessons) {
      for (const card of lesson.flashcards ?? []) {
        const stored = state.fields[`review:${card.id}`]?.value as { card?: StoredCard } | undefined
        cards.push({
          id: card.id, card, lessonTitle: lesson.title, order: cards.length,
          eligible: lessonDone(state, lesson.slug),
          state: stored?.card ? deserializeCard(stored.card) : undefined
        })
      }
    }
  }
  return cards
}

export const reviewSummary = (course: CourseView, state: LearningState, now = new Date()): ReviewSummary =>
  summarizeReview(reviewCandidates(course, state), now)
