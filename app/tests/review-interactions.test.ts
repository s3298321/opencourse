import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReviewAnswer, ReviewSession } from '../src/core/types'
import Review from '../src/renderer/routes/Review'

// These checks exercise review navigation and focus, independent of markdown parsing.
vi.mock('../src/renderer/components/Html', () => ({ default: ({ source }: { source: string }) => createElement('div', null, source) }))
const session: ReviewSession = {
  id: 'session', courseId: 'course', courseTitle: 'Memory practice', total: 2, reviewed: 0,
  ratings: { again: 0, hard: 0, good: 0, easy: 0 },
  card: { id: 'first', question: 'First question', lessonId: 'lesson', lessonTitle: 'Lesson one', early: false },
  summary: { total: 2, eligible: 2, due: 0, new: 2, practiced: 0, estimatedRecall: null, nextDue: null }
}
const answer: ReviewAnswer = { answer: 'The answer', intervals: { again: '2030-01-01', hard: '2030-01-02', good: '2030-01-03', easy: '2030-01-04' } }
let root: Root, container: HTMLDivElement
const reveal = vi.fn(), rate = vi.fn(), end = vi.fn(), navigate = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('opencourse', { revealReviewAnswer: reveal, rateReviewCard: rate, endReviewSession: end })
  reveal.mockResolvedValue(answer); end.mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.resetAllMocks() })
async function render(active = true) { await act(async () => root.render(createElement(Review, { initialSession: session, navigate, active }))) }
async function key(key: string, code = key) { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }))) }

it('keeps the session alive through StrictMode effect replay and ends it only on departure', async () => {
  let ended = false
  end.mockImplementation(async () => { ended = true })
  reveal.mockImplementation(async () => {
    if (ended) throw new Error('This review session has ended.')
    return answer
  })
  await act(async () => root.render(createElement(StrictMode, null, createElement(Review, { initialSession: session, navigate }))))
  expect(end).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('.review-reveal button')!.click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('.review-answer')?.textContent).toContain('The answer')
  await act(async () => root.render(null))
  expect(end).toHaveBeenCalledExactlyOnceWith(session.id)
})

it('reveals once, focuses the answer, and resets scroll and focus when advancing', async () => {
  let resolveReveal!: (value: ReviewAnswer) => void
  reveal.mockImplementation(() => new Promise<ReviewAnswer>(resolve => { resolveReveal = resolve }))
  rate.mockResolvedValue({ ...session, reviewed: 1, card: { ...session.card, id: 'second', question: 'Second question' } })
  await render()
  expect(document.activeElement).toBe(container.querySelector('.review-reveal button'))
  expect(container.querySelector('.review-answer')).toBeNull()
  await key(' ', 'Space'); await key(' ', 'Space')
  expect(reveal).toHaveBeenCalledTimes(1)
  await act(async () => resolveReveal(answer))
  expect(document.activeElement).toBe(container.querySelector('.review-answer h2'))
  expect(container.querySelectorAll('.review-controls .review-ratings button')).toHaveLength(4)
  const scroller = container.querySelector<HTMLElement>('.review-content')!
  scroller.scrollTop = 400
  await key('3')
  expect(rate).toHaveBeenCalledWith('session', 'first', 'good')
  expect(container.querySelector('.review-question')?.textContent).toContain('Second question')
  expect(container.querySelector('.review-answer')).toBeNull()
  expect(scroller.scrollTop).toBe(0)
  expect(document.activeElement).toBe(container.querySelector('.review-reveal button'))
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1')
})

it('retains the revealed card on save failure and allows retry through completion', async () => {
  rate.mockRejectedValueOnce(new Error('Could not save')).mockResolvedValueOnce({ ...session, card: null, reviewed: 2, ratings: { ...session.ratings, good: 2 } })
  await render(); await key(' ', 'Space'); await key('3')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
  expect(container.querySelector('.review-answer')?.textContent).toContain('The answer')
  expect(container.querySelector('.review-ratings button:disabled')).toBeNull()
  await key('3')
  expect(container.querySelector('.review-complete')).not.toBeNull()
  expect(document.activeElement).toBe(container.querySelector('.review-complete h1'))
  expect(container.querySelector('.review-controls')).toBeNull()
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2')
  await key('Escape')
  expect(navigate).toHaveBeenCalledWith({ name: 'course', courseId: 'course' })
})

it('ignores keyboard shortcuts when inactive or typing, and cleans up its session', async () => {
  await render(false); await key(' ', 'Space'); await key('Escape')
  expect(reveal).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  await render()
  const input = document.createElement('input'); container.append(input)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })))
  expect(reveal).not.toHaveBeenCalled()
  await act(async () => root.render(null))
  expect(end).toHaveBeenCalledWith('session')
})
