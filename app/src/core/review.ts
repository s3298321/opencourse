import { createEmptyCard, fsrs, generatorParameters, Rating, State } from 'ts-fsrs'
import type { Card, Grade, ReviewLog } from 'ts-fsrs'
import type { ReviewRating, ReviewSummary } from './types'

export const REVIEW_RATINGS: ReviewRating[] = ['again', 'hard', 'good', 'easy']
export const REVIEW_CONFIGURATION = {
  version: 1, library: 'ts-fsrs@5.4.2',
  parameters: generatorParameters({ request_retention: 0.9, enable_fuzz: false, enable_short_term: true,
    learning_steps: ['1m', '10m'], relearning_steps: ['10m'] })
}
const scheduler = fsrs(REVIEW_CONFIGURATION.parameters)
const ratings: Record<ReviewRating, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy }
export type StoredCard = Omit<Card, 'due' | 'last_review'> & { due: string; last_review?: string }
export function serializeCard(card: Card): StoredCard {
  return { ...card, due: card.due.toISOString(), last_review: card.last_review?.toISOString() }
}
export function deserializeCard(card: StoredCard): Card {
  const restored = { ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined }
  if (!Number.isFinite(restored.due.getTime()) || restored.last_review && !Number.isFinite(restored.last_review.getTime()) ||
    ![State.New, State.Learning, State.Review, State.Relearning].includes(restored.state) ||
    ![restored.stability, restored.difficulty, restored.reps, restored.lapses, restored.scheduled_days, restored.elapsed_days, restored.learning_steps].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('This card’s review data is invalid. Reset its review progress in the course editor.')
  }
  return restored
}
export function scheduleCard(card: Card | undefined, rating: ReviewRating, now: Date): { card: Card; log: ReviewLog } {
  return scheduler.next(card ?? createEmptyCard(now), now, ratings[rating])
}
export function recall(card: Card, now: Date): number {
  return scheduler.get_retrievability(card, now, false)
}
export function previewIntervals(card: Card | undefined, now: Date): Record<ReviewRating, string> {
  return Object.fromEntries(REVIEW_RATINGS.map(rating => [rating, scheduleCard(card, rating, now).card.due.toISOString()])) as Record<ReviewRating, string>
}
export interface ReviewCandidate { id: string; order: number; eligible: boolean; state?: Card }
export function reviewQueue(cards: ReviewCandidate[], count: number, now: Date): string[] {
  const eligible = cards.filter(card => card.eligible)
  const stable = (a: ReviewCandidate, b: ReviewCandidate): number => a.id.localeCompare(b.id)
  const due = eligible.filter(card => card.state && card.state.due <= now)
    .sort((a, b) => a.state!.due.getTime() - b.state!.due.getTime() || stable(a, b))
  const unseen = eligible.filter(card => !card.state).sort((a, b) => a.order - b.order || stable(a, b))
  const early = eligible.filter(card => card.state && card.state.due > now)
    .sort((a, b) => recall(a.state!, now) - recall(b.state!, now) || a.state!.due.getTime() - b.state!.due.getTime() || stable(a, b))
  return [...due, ...unseen, ...early].slice(0, count).map(card => card.id)
}
export function summarizeReview(cards: ReviewCandidate[], now: Date): ReviewSummary {
  const eligible = cards.filter(card => card.eligible), practiced = eligible.filter(card => card.state)
  const future = practiced.map(card => card.state!.due).filter(date => date > now).sort((a, b) => a.getTime() - b.getTime())
  return { total: cards.length, eligible: eligible.length, due: practiced.filter(card => card.state!.due <= now).length,
    new: eligible.length - practiced.length, practiced: practiced.length,
    estimatedRecall: practiced.length ? practiced.reduce((sum, card) => sum + recall(card.state!, now), 0) / practiced.length : null,
    nextDue: future[0]?.toISOString() ?? null }
}
