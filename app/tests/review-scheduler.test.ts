import { describe, expect, it } from 'vitest'
import { createEmptyCard, State } from 'ts-fsrs'
import { deserializeCard, previewIntervals, recall, reviewQueue, scheduleCard, serializeCard, summarizeReview } from '../src/core/review'
import type { ReviewCandidate } from '../src/core/review'

const now = new Date('2026-10-06T10:00:00Z')
describe('FSRS scheduling and selection', () => {
  it('previews four deterministic outcomes and round trips dates', () => {
    const preview = previewIntervals(undefined, now)
    expect(new Date(preview.again).getTime() - now.getTime()).toBe(60000)
    expect(new Date(preview.good).getTime() - now.getTime()).toBe(600000)
    expect(preview).toEqual(previewIntervals(undefined, now))
    for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
      const { card, log } = scheduleCard(undefined, rating, now)
      expect(card.due.getTime()).toBeGreaterThan(now.getTime())
      expect(log.review).toEqual(now)
      expect(deserializeCard(serializeCard(card))).toEqual(card)
    }
  })
  it('learns, graduates, handles early/late review and relearns forgotten cards', () => {
    const learning = scheduleCard(undefined, 'good', now).card
    expect(learning.state).toBe(State.Learning)
    const reviewed = scheduleCard(learning, 'good', learning.due).card
    expect(reviewed.state).toBe(State.Review)
    const forgotten = scheduleCard(reviewed, 'again', reviewed.due).card
    expect(forgotten.state).toBe(State.Relearning)
    expect(forgotten.lapses).toBeGreaterThan(reviewed.lapses)
    const late = new Date(reviewed.due.getTime() + 10 * 86400000)
    expect(recall(reviewed, late)).toBeLessThan(recall(reviewed, learning.due))
    expect(scheduleCard(reviewed, 'good', late).card.due > late).toBe(true)
    expect(scheduleCard(reviewed, 'easy', learning.due).card.due > learning.due).toBe(true)
  })
  it('prioritizes due, unseen and early cards, excludes locked lessons, and never repeats', () => {
    const early = scheduleCard(undefined, 'easy', now).card
    const due = { ...early, due: new Date(now.getTime() - 60000) }
    const cards: ReviewCandidate[] = [
      { id: 'early', order: 0, eligible: true, state: early }, { id: 'new', order: 1, eligible: true },
      { id: 'due-b', order: 2, eligible: true, state: due }, { id: 'locked', order: 3, eligible: false, state: due },
      { id: 'due-a', order: 4, eligible: true, state: due }
    ]
    expect(reviewQueue(cards, 20, now)).toEqual(['due-a', 'due-b', 'new', 'early'])
    expect(reviewQueue(cards, 2, now)).toEqual(['due-a', 'due-b'])
    expect(summarizeReview(cards, now)).toMatchObject({ total: 5, eligible: 4, due: 2, new: 1, practiced: 3, nextDue: early.due.toISOString() })
  })
  it('fills all session sizes and reports no mastery before any review', () => {
    const cards = Array.from({ length: 30 }, (_, order) => ({ id: String(order), order, eligible: true }))
    for (const count of [10, 15, 20]) expect(reviewQueue(cards, count, now)).toHaveLength(count)
    expect(summarizeReview(cards, now).estimatedRecall).toBeNull()
    expect(summarizeReview([], now)).toMatchObject({ total: 0, eligible: 0, nextDue: null })
  })
  it('refuses invalid stored dates and nonfinite memory state', () => {
    const stored = serializeCard(createEmptyCard(now))
    expect(() => deserializeCard({ ...stored, due: 'bad' })).toThrow('invalid')
    expect(() => deserializeCard({ ...stored, stability: NaN })).toThrow('invalid')
  })
})
