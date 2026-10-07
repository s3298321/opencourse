import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Review from '../src/renderer/routes/Review'
import CourseDetail from '../src/renderer/routes/CourseDetail'
import { buildCourse } from '../src/core/manifest'
import { emptyProgress } from '../src/core/progress'
import type { ReviewSession } from '../src/core/types'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/markdown-context', async () => {
  const { default: MarkdownIt } = await import('markdown-it')
  const md = new MarkdownIt()
  return { useMarkdown: () => md }
})
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const initial = (): ReviewSession => ({ id: 'session', courseId: 'course', courseTitle: 'Course', total: 2, reviewed: 0,
  ratings: { again: 0, hard: 0, good: 0, easy: 0 }, card: { id: 'one', question: '**First question?**', lessonId: 'lesson', lessonTitle: 'Lesson', early: false, image: { src: 'opencourse://course/card.png', alt: 'Diagram' } },
  summary: { total: 2, eligible: 2, due: 0, new: 2, practiced: 0, estimatedRecall: null, nextDue: null } })
function api() {
  const intervals = { again: '2026-10-06T10:01:00Z', hard: '2026-10-06T10:06:00Z', good: '2026-10-06T10:10:00Z', easy: '2026-10-10T10:00:00Z' }
  const result = { revealReviewAnswer: vi.fn(async () => ({ answer: '**Private answer**', intervals })), rateReviewCard: vi.fn(async (): Promise<ReviewSession> => ({ ...initial(), reviewed: 2, card: null, ratings: { again: 0, hard: 0, good: 2, easy: 0 }, summary: { ...initial().summary, new: 0, practiced: 2, nextDue: intervals.good } })), endReviewSession: vi.fn(async () => {}) }
  vi.stubGlobal('opencourse', result)
  return result
}
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label))!
const press = async (key: string, code?: string) => act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })))
describe('flashcard review screen', () => {
  it('hides answers, reveals with Space, persists once and advances with rating keys', async () => {
    const service = api(), navigate = vi.fn()
    let complete!: (value: ReviewSession) => void
    service.rateReviewCard.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await act(async () => root.render(createElement(Review, { initialSession: initial(), navigate })))
    expect(container.textContent).not.toContain('Private answer')
    expect(document.activeElement).toBe(button('Reveal answer'))
    expect(container.querySelector('img')?.alt).toBe('Diagram')
    await press('3')
    expect(service.rateReviewCard).not.toHaveBeenCalled()
    await press(' ', 'Space')
    expect(container.querySelector('.review-answer strong')?.textContent).toBe('Private answer')
    expect(document.activeElement).toBe(button('Again'))
    await press('3'); await press('3')
    expect(service.rateReviewCard).toHaveBeenCalledTimes(1)
    expect(service.rateReviewCard).toHaveBeenCalledWith('session', 'one', 'good')
    expect(button('Good').disabled).toBe(true)
    await act(async () => complete({ ...initial(), reviewed: 1, card: { ...initial().card!, id: 'two', question: 'Second question?' } }))
    expect(container.textContent).toContain('Second question?')
    expect(container.textContent).not.toContain('Private answer')
    expect(document.activeElement).toBe(button('Reveal answer'))
    await press('Escape')
    expect(navigate).toHaveBeenCalledWith({ name: 'course', courseId: 'course' })
  })
  it('retains the revealed card after a save failure and completes on retry', async () => {
    const service = api(), navigate = vi.fn()
    service.rateReviewCard.mockRejectedValueOnce(new Error('Disk full'))
    await act(async () => root.render(createElement(Review, { initialSession: initial(), navigate })))
    await act(async () => button('Reveal answer').click())
    await act(async () => button('Good').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Disk full')
    expect(container.textContent).toContain('Private answer')
    await act(async () => button('Good').click())
    expect(container.textContent).toContain('You reviewed 2 cards')
    expect(container.querySelector('.review-result-counts')?.textContent).toContain('2Good')
    expect(document.activeElement).toBe(container.querySelector('h1'))
    await act(async () => button('Back to course').click())
    expect(navigate).toHaveBeenCalledWith({ name: 'course', courseId: 'course' })
    await act(async () => root.unmount())
    expect(service.endReviewSession).toHaveBeenCalledWith('session')
    root = createRoot(container)
  })
  it('ignores rating shortcuts while inactive behind settings', async () => {
    const service = api()
    await act(async () => root.render(createElement(Review, { initialSession: initial(), navigate: vi.fn(), active: false })))
    await press(' ', 'Space')
    expect(service.revealReviewAnswer).not.toHaveBeenCalled()
  })
})
/** A local course on a machine with no servers: the course page's server half has nothing to ask. */
const noServers = { listServers: async () => [], onServersChanged: () => () => {}, checkCourseUpdates: async () => ({}) }
describe('course overview review controls', () => {
  it('defaults to ten, accepts fifteen/twenty, shows estimates and refreshes on events/focus', async () => {
    const course = buildCourse({ schema_version: '1.4', slug: 'course', title: 'Course', modules: [{ slug: 'module', title: 'Module', lessons: [{ slug: 'lesson', title: 'Lesson', blocks: [] }] }] }, '/tmp')
    let changed!: (id: string) => void
    const service = { getCourse: vi.fn(async () => course), getProgress: vi.fn(async () => emptyProgress('course')), getReviewSummary: vi.fn(async () => ({ ...initial().summary, practiced: 1, new: 1, estimatedRecall: 0.88 })),
      onCoursesChanged: () => () => {}, onReviewChanged: (handler: (id: string) => void) => { changed = handler; return () => {} }, startReviewSession: vi.fn(async () => initial()), ...noServers }
    vi.stubGlobal('opencourse', service)
    const navigate = vi.fn()
    await act(async () => root.render(createElement(CourseDetail, { courseId: 'course', user: null, route: { name: 'course', courseId: 'course' }, navigate })))
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Number of flashcards"]')!
    expect(select.value).toBe('10')
    expect([...select.options].map(option => option.value)).toEqual(['10', '15', '20'])
    expect(container.textContent).toContain('88% estimated recall')
    await act(async () => { select.value = '15'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Review').click())
    expect(service.startReviewSession).toHaveBeenLastCalledWith('course', 15)
    expect(navigate).toHaveBeenCalledWith({ name: 'review', session: initial() })
    const before = service.getReviewSummary.mock.calls.length
    await act(async () => { changed('course'); window.dispatchEvent(new Event('focus')) })
    expect(service.getReviewSummary.mock.calls.length).toBeGreaterThan(before)
  })
  it('disables reviews for locked or empty decks and explains why', async () => {
    const course = buildCourse({ schema_version: '1.4', slug: 'course', title: 'Course', modules: [] }, '/tmp')
    vi.stubGlobal('opencourse', { getCourse: async () => course, getProgress: async () => emptyProgress('course'), getReviewSummary: async () => ({ ...initial().summary, eligible: 0, new: 0 }), onCoursesChanged: () => () => {}, onReviewChanged: () => () => {}, ...noServers })
    await act(async () => root.render(createElement(CourseDetail, { courseId: 'course', user: null, route: { name: 'course', courseId: 'course' }, navigate: vi.fn() })))
    expect(button('Review').disabled).toBe(true)
    expect(container.textContent).toContain('Complete a lesson with flashcards')
  })
})
