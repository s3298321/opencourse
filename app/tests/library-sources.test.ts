import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CourseSummary, ServerConnection } from '../src/core/types'
import type { Screen } from '../src/renderer/routes'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/components/Html', () => ({ default: ({ source, className }: { source: string; className: string }) => h('p', { className }, source) }))
import Library from '../src/renderer/routes/Library'

let root: Root
let container: HTMLDivElement
let coursesChanged: () => void
let serversChanged: () => void
let courses: CourseSummary[]
let servers: ServerConnection[]
const navigate = vi.fn()
const server = (id: string, url: string): ServerConnection => ({ id, url, name: 'School', description: '', account: null, active: false })
const course = (id: string, url?: string): CourseSummary => ({
  courseId: id, slug: id, title: id, lessonCount: 3, projectCount: 0, description: 'A course description.',
  ...(url ? { origin: { server: url, serverName: 'School', role: 'learner' as const, publisher: 'author' } } : {})
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  servers = [server('one', 'https://one.test'), server('two', 'https://two.test')]
  courses = [course('Local course'), course('First server course', servers[0].url), course('Second server course', servers[1].url)]
  vi.stubGlobal('opencourse', {
    listCourses: vi.fn(async () => courses), listServers: vi.fn(async () => servers),
    checkCourseUpdates: vi.fn(async () => ({})),
    onCoursesChanged: vi.fn((callback) => { coursesChanged = callback; return () => {} }),
    onServersChanged: vi.fn((callback) => { serversChanged = callback; return () => {} })
  })
  navigate.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const render = async (route: Screen = { name: 'library' }) => act(async () => root.render(h(Library, { user: null, navigate, importSignal: 0, route })))
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('.course-source-tabs button')]
const titles = () => [...container.querySelectorAll('.course-card h3')].map(card => card.textContent)
const select = async (index: number) => act(async () => tabs()[index].click())

describe('Course source transitions', () => {
  let preference: MediaQueryList
  let originalAnimate: PropertyDescriptor | undefined
  let animations: { target: HTMLElement; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn>; finish: () => void }[]

  beforeEach(() => {
    animations = []
    preference = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList
    vi.stubGlobal('matchMedia', vi.fn(() => preference))
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value(this: HTMLElement, frames: Keyframe[]) {
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve })
      const cancel = vi.fn(finish)
      animations.push({ target: this, frames, cancel, finish })
      return { finished, cancel }
    } })
  })
  afterEach(() => {
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate
  })

  const liveTitles = () => [...container.querySelectorAll('.course-source-content:not(.course-source-departing) .course-card h3')].map(card => card.textContent)
  const departing = () => container.querySelector<HTMLElement>('.course-source-departing')

  it('slides the whole old panel left and brings the new panel from the right, reversing on keyboard navigation', async () => {
    await render()
    expect(animations).toHaveLength(0)
    await select(2)
    expect(liveTitles()).toEqual(['Second server course'])
    expect(departing()?.textContent).toContain('Local course')
    expect(departing()?.querySelector('.course-status-filters')).not.toBeNull()
    expect(departing()?.getAttribute('aria-hidden')).toBe('true')
    expect(departing()?.inert).toBe(true)
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
    expect(animations[0].frames[1].transform).toBe('translateX(-32px)')
    expect(animations[1].frames[0]).toEqual({ opacity: 0, transform: 'translateX(32px)' })
    await act(async () => animations.forEach(animation => animation.finish()))
    expect(departing()).toBeNull()
    expect(container.querySelector<HTMLElement>('[role="tabpanel"]')?.style.minHeight).toBe('')
    tabs()[2].focus()
    await act(async () => tabs()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(tabs()[0])
    expect(liveTitles()).toEqual(['Local course'])
    expect(animations[2].frames[1].transform).toBe('translateX(32px)')
    expect(animations[3].frames[0].transform).toBe('translateX(-32px)')
  })

  it('replaces an interrupted transition and cleans up when motion is reduced or the page unmounts', async () => {
    await render()
    await select(1)
    await select(2)
    expect(animations[0].cancel).toHaveBeenCalledOnce()
    expect(animations[1].cancel).toHaveBeenCalledOnce()
    expect(container.querySelectorAll('.course-source-departing')).toHaveLength(1)
    expect(departing()?.textContent).toContain('First server course')
    expect(liveTitles()).toEqual(['Second server course'])
    Object.assign(preference, { matches: true })
    await act(async () => preference.dispatchEvent(new Event('change')))
    expect(departing()).toBeNull()
    await select(0)
    expect(liveTitles()).toEqual(['Local course'])
    expect(animations).toHaveLength(4)
    Object.assign(preference, { matches: false })
    await select(1)
    await act(async () => root.render(null))
    expect(animations[4].cancel).toHaveBeenCalledOnce()
    expect(animations[5].cancel).toHaveBeenCalledOnce()
  })

  it('does not animate data refreshes, status filters, or reselecting the current tab', async () => {
    await render()
    await select(0)
    await act(async () => coursesChanged())
    await act(async () => container.querySelector<HTMLButtonElement>('.course-status-filter')!.click())
    expect(animations).toHaveLength(0)
    Object.assign(preference, { matches: true })
    await select(1)
    expect(animations).toHaveLength(0)
    expect(departing()).toBeNull()
    expect(container.querySelector('.empty-library h3')?.textContent).toBe('No in progress courses')
  })
})

describe('My courses source tabs', () => {
  it('offers Add courses only for a connected server, opens that server, and restores its source on return', async () => {
    await render()
    expect(container.querySelector('.library-tabs')).toBeNull()
    expect(container.querySelector('.add-courses')).toBeNull()
    await select(2)
    await act(async () => container.querySelector<HTMLButtonElement>('.add-courses')!.click())
    expect(navigate).toHaveBeenLastCalledWith({ name: 'catalog', serverId: 'two' })
    await select(0)
    await render({ name: 'library', source: 'two' })
    expect(titles()).toEqual(['Second server course'])
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true')
    courses = [...courses, course('Disconnected course', 'https://removed.test')]
    await act(async () => coursesChanged())
    await select(3)
    expect(container.querySelector('.add-courses')).toBeNull()
  })
  it('separates local and server courses by connection even with duplicate server names and signed-out accounts', async () => {
    await render()
    expect(tabs().map(tab => tab.textContent)).toEqual(['Local1', 'School1', 'School1'])
    expect(titles()).toEqual(['Local course'])
    await select(1)
    expect(titles()).toEqual(['First server course'])
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    await act(async () => container.querySelector<HTMLElement>('.course-card')!.click())
    expect(navigate).toHaveBeenCalledWith({ name: 'course', courseId: 'First server course' })
    await select(2)
    expect(titles()).toEqual(['Second server course'])
  })

  it('refreshes connections and imports, retaining disconnected courses and recovering from a removed tab', async () => {
    await render()
    await select(1)
    servers = servers.slice(1)
    await act(async () => serversChanged())
    expect(tabs().map(tab => tab.textContent)).toEqual(['Local1', 'School1', 'Disconnected1'])
    expect(titles()).toEqual(['Local course'])
    await select(2)
    expect(titles()).toEqual(['First server course'])
    courses = [...courses, course('Imported course')]
    await act(async () => coursesChanged())
    await select(0)
    expect(titles()).toEqual(['Imported course', 'Local course'])
    servers = [server('one', 'https://one.test'), ...servers]
    await act(async () => serversChanged())
    expect(tabs().map(tab => tab.textContent)).toEqual(['Local2', 'School1', 'School1'])
  })

  it('supports arrow, Home and End navigation with focus following the selected tab', async () => {
    await render()
    tabs()[0].focus()
    const key = async (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
    await key('ArrowLeft')
    expect(document.activeElement).toBe(tabs()[2])
    expect(titles()).toEqual(['Second server course'])
    await key('ArrowRight')
    expect(document.activeElement).toBe(tabs()[0])
    await key('End')
    expect(document.activeElement).toBe(tabs()[2])
    await key('Home')
    expect(document.activeElement).toBe(tabs()[0])
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs()[0].id)
  })

  it('shows a source-specific empty state without hiding other courses', async () => {
    courses = [course('Local course')]
    await render()
    await select(1)
    expect(titles()).toEqual([])
    expect(container.querySelector('.empty-library h3')?.textContent).toBe('No courses from School yet')
    await select(0)
    expect(titles()).toEqual(['Local course'])
  })

  it('orders statuses and recent opens, and applies circle filters within the selected source', async () => {
    courses = [
      { ...course('Completed older'), progressStatus: 'completed', progressPercent: 100, lastOpenedAt: '2026-10-01T10:00:00Z' },
      course('Not started'),
      { ...course('Started older'), progressStatus: 'in-progress', progressPercent: 50, lastOpenedAt: '2026-10-02T10:00:00Z' },
      { ...course('Completed recent'), progressStatus: 'completed', progressPercent: 100, lastOpenedAt: '2026-10-09T10:00:00Z' },
      { ...course('Started recent'), progressStatus: 'in-progress', progressPercent: 0, lastOpenedAt: '2026-10-08T10:00:00Z' },
      { ...course('Server started', servers[0].url), progressStatus: 'in-progress', progressPercent: 20 }
    ]
    await render()
    const ordered = ['Started recent', 'Started older', 'Not started', 'Completed recent', 'Completed older']
    expect(titles()).toEqual(ordered)
    const filter = (label: string) => container.querySelector<HTMLButtonElement>(`.course-status-filter[aria-label="${label}"]`)!
    await act(async () => filter('In progress').click())
    expect(filter('In progress').getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['Started recent', 'Started older'])
    await select(1)
    expect(titles()).toEqual(['Server started'])
    await act(async () => filter('Completed').click())
    expect(titles()).toEqual([])
    expect(container.querySelector('.empty-library h3')?.textContent).toBe('No completed courses')
    await select(0)
    expect(titles()).toEqual(['Completed recent', 'Completed older'])
    await act(async () => filter('Completed').click())
    expect(titles()).toEqual(ordered)
    await act(async () => filter('Not started').click())
    expect(titles()).toEqual(['Not started'])
    courses = courses.map((item) => item.title === 'Not started' ? { ...item, progressStatus: 'in-progress', progressPercent: 33 } : item)
    await act(async () => coursesChanged())
    expect(titles()).toEqual([])
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show all courses')!.click())
    expect(titles()).toHaveLength(5)
  })
})
