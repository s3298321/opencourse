import { randomUUID } from 'node:crypto'
import type { Course, Flashcard, ReviewAnswer, ReviewCount, ReviewRating, ReviewSession, ReviewSummary } from '../core/types'
import { deserializeCard, previewIntervals, REVIEW_CONFIGURATION, REVIEW_RATINGS, reviewQueue, scheduleCard, serializeCard, summarizeReview } from '../core/review'
import type { ReviewCandidate, StoredCard } from '../core/review'
import { lessonKey } from '../core/manifest'
import { db, tx } from './db'
import { getCourse } from './courses'
import { readProgress } from './progress'
import { requireUser } from './users'
import { assertCourseAvailable } from './course-busy'

interface Candidate extends ReviewCandidate { card: Flashcard; lessonId: string; lessonTitle: string; version: number }
interface ActiveSession {
  id: string; userId: string; senderId: number; courseId: string; revision: number; queue: string[];
  index: number; revealed: boolean; expectedVersion: number; ratings: Record<ReviewRating, number>;
  receipts: Map<string, { rating: ReviewRating; result: ReviewSession }>
}
const sessions = new Map<string, ActiveSession>()
function requireCourse(courseId: string): Course {
  assertCourseAvailable(courseId)
  const course = getCourse(courseId)
  if (!course) throw new Error('This course is no longer available.')
  return course
}
function candidates(course: Course): Candidate[] {
  const completed = new Set(readProgress(course.courseId).completedLessons)
  const states = new Map((db().prepare('SELECT card_id, state, version FROM flashcard_states WHERE course_id=?').all(course.courseId) as { card_id: string; state: string; version: number }[]).map(row => [row.card_id, row]))
  const cards: Candidate[] = []
  for (const module of course.modules) if (module.type !== 'project') for (const lesson of module.lessons) {
    for (const card of lesson.flashcards ?? []) {
      const row = states.get(card.id)
      cards.push({ id: card.id, card, lessonId: lesson.slug, lessonTitle: lesson.title, order: cards.length,
        eligible: completed.has(lessonKey(module.slug, lesson.slug)), version: row?.version ?? 0,
        state: row ? deserializeCard(JSON.parse(row.state) as StoredCard) : undefined })
    }
  }
  return cards
}
export function getReviewSummary(courseId: string, now = new Date()): ReviewSummary {
  return summarizeReview(candidates(requireCourse(courseId)), now)
}
function sessionView(session: ActiveSession, now: Date): ReviewSession {
  const course = requireCourse(session.courseId), cards = candidates(course)
  const current = cards.find(card => card.id === session.queue[session.index])
  return { id: session.id, courseId: course.courseId, courseTitle: course.title, total: session.queue.length,
    reviewed: session.index, ratings: { ...session.ratings }, summary: summarizeReview(cards, now),
    card: current ? { id: current.id, question: current.card.question, image: current.card.image,
      lessonId: current.lessonId, lessonTitle: current.lessonTitle, early: Boolean(current.state && current.state.due > now) } : null }
}
function requireSession(id: string, senderId: number): ActiveSession {
  const session = sessions.get(id)
  if (!session || session.userId !== requireUser() || session.senderId !== senderId) throw new Error('This review session has ended. Return to the course to start another.')
  const course = requireCourse(session.courseId)
  if (course.revision !== session.revision) {
    sessions.delete(id)
    throw new Error('The course changed during review. Return to the course to start another session.')
  }
  return session
}
function currentCard(session: ActiveSession, cardId: string): Candidate {
  const candidate = candidates(requireCourse(session.courseId)).find(card => card.id === cardId)
  if (session.queue[session.index] !== cardId || !candidate?.eligible) throw new Error('This card is no longer available in this session.')
  if (candidate.version !== session.expectedVersion) throw new Error('This card was reviewed in another window. Return to the course to start another session.')
  return candidate
}
export function startReviewSession(courseId: string, count: ReviewCount, senderId: number, now = new Date()): ReviewSession {
  if (![10, 15, 20].includes(count)) throw new Error('Choose 10, 15, or 20 cards.')
  const course = requireCourse(courseId), cards = candidates(course), queue = reviewQueue(cards, count, now)
  if (!queue.length) throw new Error('Complete a lesson with flashcards to unlock review.')
  endWindowReviews(senderId)
  const session: ActiveSession = { id: randomUUID(), userId: requireUser(), senderId, courseId, revision: course.revision, queue,
    index: 0, revealed: false, expectedVersion: cards.find(card => card.id === queue[0])!.version,
    ratings: { again: 0, hard: 0, good: 0, easy: 0 }, receipts: new Map() }
  sessions.set(session.id, session)
  return sessionView(session, now)
}
export function revealReviewAnswer(id: string, cardId: string, senderId: number, now = new Date()): ReviewAnswer {
  const session = requireSession(id, senderId), current = currentCard(session, cardId)
  session.revealed = true
  return { answer: current.card.answer, intervals: previewIntervals(current.state, now) }
}
export function rateReviewCard(id: string, cardId: string, rating: ReviewRating, senderId: number, now = new Date()): ReviewSession {
  const session = requireSession(id, senderId)
  if (!REVIEW_RATINGS.includes(rating)) throw new Error('Invalid review rating.')
  const receipt = session.receipts.get(cardId)
  if (receipt) {
    if (receipt.rating !== rating) throw new Error('This card has already been rated.')
    return receipt.result
  }
  const current = currentCard(session, cardId)
  if (!session.revealed) throw new Error('Reveal the answer before rating this card.')
  const result = scheduleCard(current.state, rating, now)
  // Prepare the response before committing so a response read failure cannot
  // leave a durable rating behind an unadvanced in-memory session.
  const next = { ...session, index: session.index + 1, revealed: false, ratings: { ...session.ratings, [rating]: session.ratings[rating] + 1 } }
  const nextCandidate = candidates(requireCourse(session.courseId)).find(card => card.id === session.queue[next.index])
  next.expectedVersion = nextCandidate?.version ?? 0
  const view = sessionView(next, now)
  view.summary = summarizeReview(candidates(requireCourse(session.courseId)).map(card => card.id === cardId ? { ...card, state: result.card } : card), now)
  tx(d => {
    const latest = d.prepare('SELECT version FROM flashcard_states WHERE card_id=?').get(cardId) as { version: number } | undefined
    if ((latest?.version ?? 0) !== current.version) throw new Error('This card changed in another window.')
    d.prepare(`INSERT INTO flashcard_states(card_id,course_id,due,state,configuration,version) VALUES(?,?,?,?,?,?)
      ON CONFLICT(card_id) DO UPDATE SET due=excluded.due,state=excluded.state,configuration=excluded.configuration,version=excluded.version`)
      .run(cardId, session.courseId, result.card.due.toISOString(), JSON.stringify(serializeCard(result.card)), JSON.stringify(REVIEW_CONFIGURATION), current.version + 1)
    d.prepare('INSERT INTO flashcard_reviews(session_id,card_id,rating,at,log) VALUES(?,?,?,?,?)')
      .run(id, cardId, rating, now.toISOString(), JSON.stringify(result.log))
  })
  Object.assign(session, next)
  session.receipts.set(cardId, { rating, result: view })
  return view
}
export function endReviewSession(id: string, senderId: number): void {
  const session = sessions.get(id)
  if (session && session.senderId === senderId && session.userId === requireUser()) sessions.delete(id)
}
export function endWindowReviews(senderId: number): void {
  for (const [id, session] of sessions) if (session.senderId === senderId) sessions.delete(id)
}
export function invalidateCourseReviews(courseId: string): void {
  for (const [id, session] of sessions) if (session.courseId === courseId && session.userId === requireUser()) sessions.delete(id)
}
export function endAllReviews(): void { sessions.clear() }
export function resetFlashcardProgress(courseId: string, cardId: string): void {
  const course = requireCourse(courseId)
  if (!course.modules.some(module => module.type !== 'project' && module.lessons.some(lesson => lesson.flashcards?.some(card => card.id === cardId)))) throw new Error('This saved card no longer exists.')
  tx(d => { d.prepare('DELETE FROM flashcard_states WHERE course_id=? AND card_id=?').run(courseId, cardId) })
  invalidateCourseReviews(courseId)
}
