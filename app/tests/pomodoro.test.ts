import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advancePomodoro, formatPomodoroTime, normalizePomodoroSettings } from '../src/core/pomodoro'
import { normalizePreferences } from '../src/core/preferences'
import Pomodoro, { POMODORO_SETTINGS_CHANGED } from '../src/renderer/components/Pomodoro'
import PomodoroSettings from '../src/renderer/components/PomodoroSettings'
import { TitleBarChrome } from '../src/renderer/components/TitleBar'
vi.mock('../src/renderer/components/useAppUpdate', () => ({ useAppUpdate: () => null }))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('opencourse', {
    getPomodoroSettings: vi.fn(async () => ({ studyMinutes: 40, breakMinutes: 5 })),
    setPomodoroSettings: vi.fn(async value => value)
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals()
})
const render = async () => act(async () => root.render(createElement(Pomodoro)))
const click = async (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click())
const advance = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })
const expanded = () => container.querySelector('.pomodoro')?.getAttribute('data-expanded') === 'true'
const phase = () => container.querySelector('.pomodoro')?.getAttribute('data-phase')
const timer = () => container.querySelector('[role="timer"]')?.textContent
const hover = async (on: boolean) => act(async () => {
  container.querySelector('.pomodoro')!.dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: document.body }))
})
const start = async () => { await click('.pomodoro-icon'); await click('.pomodoro-yes') }

describe('Pomodoro title bar', () => {
  it('retains outgoing prompts while folding and keeps them inert', async () => {
    await render(); await click('.pomodoro-icon'); await click('.pomodoro-no')
    const reveal = container.querySelector('.pomodoro > div > .pomodoro-reveal')!
    expect(expanded()).toBe(false)
    expect(reveal.textContent).toContain('Start a study session ?')
    expect(reveal.hasAttribute('inert')).toBe(true)
    expect(reveal.getAttribute('data-visible')).toBe('true')
    await advance(320)
    expect(reveal.getAttribute('data-visible')).toBe('false')
    await start(); await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(phase()).toBe('idle')
    expect(reveal.textContent).toContain('Stop session ?')
    // Reopening during a close cancels its cleanup and restores current actions.
    await advance(100); await click('.pomodoro-icon'); await advance(320)
    expect(reveal.getAttribute('data-visible')).toBe('true')
    expect(reveal.textContent).toContain('Start a study session ?')
  })

  it('continues across navigation and resets when switching users', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const user = { id: 'first', name: 'Learner', color: '#999', createdAt: '' }
    await act(async () => root.render(createElement(TitleBarChrome, { user, route: { name: 'library' } })))
    await start(); await advance(5_000)
    const control = container.querySelector('.pomodoro')
    await act(async () => root.render(createElement(TitleBarChrome, { user, route: { name: 'coach' } })))
    expect(container.querySelector('.pomodoro')).toBe(control)
    expect(phase()).toBe('study')
    await hover(false); await hover(true)
    expect(timer()).toBe('39:55')
    await act(async () => root.render(createElement(TitleBarChrome, { user: { ...user, id: 'second' }, route: { name: 'library' } })))
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
  })

  it('asks before starting, counts down, collapses after three seconds, and reveals on hover', async () => {
    await render()
    expect(expanded()).toBe(false)
    await click('.pomodoro-icon')
    expect(container.textContent).toContain('Start a study session ?')
    await click('.pomodoro-icon')
    expect(expanded()).toBe(false)
    expect(phase()).toBe('idle')
    expect(container.querySelector('.pomodoro > div > .pomodoro-reveal')?.hasAttribute('inert')).toBe(true)
    await click('.pomodoro-icon')
    expect(expanded()).toBe(true)
    await click('.pomodoro-no')
    expect(expanded()).toBe(false)
    expect(phase()).toBe('idle')
    await start()
    expect(timer()).toBe('40:00')
    expect(phase()).toBe('study')
    await advance(1_000)
    expect(timer()).toBe('39:59')
    await advance(2_000)
    expect(expanded()).toBe(false)
    await hover(false); await hover(true)
    expect(expanded()).toBe(true)
    await hover(false)
    expect(expanded()).toBe(false)
  })

  it('pins stop confirmation for ten seconds, and closes even while hovered', async () => {
    await render(); await start(); await advance(3_000)
    await hover(false); await hover(true); await click('.pomodoro-icon'); await hover(false)
    expect(container.textContent).toContain('Stop session ?')
    await advance(9_750)
    expect(expanded()).toBe(true)
    await hover(true); await advance(250)
    expect(expanded()).toBe(false)
    expect(phase()).toBe('study')
    await click('.pomodoro-icon'); await click('.pomodoro-no')
    expect(expanded()).toBe(false)
    expect(phase()).toBe('study')
    await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(phase()).toBe('idle')
    expect(expanded()).toBe(false)
    await advance(60 * 60_000)
    expect(phase()).toBe('idle')
  })

  it('waits for permission before starting a full break and then offers another session', async () => {
    await render(); await start()
    await advance(40 * 60_000)
    expect(phase()).toBe('breakReady')
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain("Time's up ! Start break ?")
    expect(timer()).toBeUndefined()
    expect(expanded()).toBe(true)
    await advance(60 * 60_000)
    expect(phase()).toBe('breakReady')
    expect(expanded()).toBe(true)
    await click('.pomodoro-yes')
    expect(phase()).toBe('break'); expect(timer()).toBe('05:00')
    await advance(3_000)
    expect(timer()).toBe('04:57')
    expect(expanded()).toBe(true)
    await advance(5 * 60_000 - 3_000)
    expect(phase()).toBe('ready')
    expect(container.textContent).toContain('Start another session ?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('study'); expect(timer()).toBe('40:00')
    await advance(40 * 60_000); await click('.pomodoro-yes'); await advance(5 * 60_000)
    await click('.pomodoro-no')
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
  })

  it.each(['no', 'icon', 'Escape'])('resets when the break invitation is dismissed with %s', async method => {
    await render(); await start(); await advance(40 * 60_000)
    if (method === 'Escape') {
      await act(async () => container.querySelector('.pomodoro')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    } else await click(method === 'no' ? '.pomodoro-no' : '.pomodoro-icon')
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain("Time's up ! Start break ?")
    expect(container.querySelector('.pomodoro-reveal')?.hasAttribute('inert')).toBe(true)
    await advance(10 * 60_000)
    expect(phase()).toBe('idle')
    await start()
    expect(timer()).toBe('40:00')
  })

  it('replaces an expiring study stop prompt with the break invitation', async () => {
    await render(); await start(); await advance(40 * 60_000 - 1_000)
    await click('.pomodoro-icon'); await advance(1_000)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain("Time's up ! Start break ?")
    await click('.pomodoro-yes')
    expect(phase()).toBe('break'); expect(timer()).toBe('05:00')
  })

  it('can dismiss, time out, or confirm stopping during a break', async () => {
    await render(); await start(); await advance(40 * 60_000); await click('.pomodoro-yes'); await advance(3_000)
    await click('.pomodoro-icon'); await hover(false)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Stop session ?')
    await advance(2_000); await click('.pomodoro-no')
    expect(phase()).toBe('break'); expect(expanded()).toBe(true)
    expect(timer()).toBe('04:55')
    await click('.pomodoro-icon'); await advance(9_750)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Stop session ?')
    await advance(250)
    expect(timer()).toBe('04:45')
    expect(expanded()).toBe(true)
    await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Stop session ?')
    await advance(10 * 60_000)
    expect(phase()).toBe('idle')
    await start()
    expect(phase()).toBe('study'); expect(timer()).toBe('40:00')
  })

  it('offers another session if the break ends during stop confirmation', async () => {
    vi.mocked(window.opencourse.getPomodoroSettings).mockResolvedValue({ studyMinutes: 1, breakMinutes: 1 })
    await render(); await start(); await advance(60_000); await click('.pomodoro-yes'); await advance(59_000)
    await click('.pomodoro-icon'); await advance(1_000)
    expect(phase()).toBe('ready')
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Start another session ?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('study'); expect(timer()).toBe('01:00')
  })

  it('applies changed durations to the next cycle without changing an active one', async () => {
    await render(); await start()
    vi.mocked(window.opencourse.getPomodoroSettings).mockResolvedValue({ studyMinutes: 1, breakMinutes: 2 })
    await act(async () => { window.dispatchEvent(new Event(POMODORO_SETTINGS_CHANGED)) })
    expect(timer()).toBe('40:00')
    await advance(40 * 60_000); await click('.pomodoro-yes')
    expect(timer()).toBe('05:00')
    await advance(5 * 60_000); await click('.pomodoro-yes')
    expect(timer()).toBe('01:00')
    await advance(60_000); await click('.pomodoro-yes')
    expect(timer()).toBe('02:00')
  })

  it('catches up after suspension, handles Escape, and returns keyboard focus on dismissal', async () => {
    await render(); await start()
    await click('.pomodoro-icon')
    const no = container.querySelector<HTMLButtonElement>('.pomodoro-no')!
    await act(async () => { no.focus(); no.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(expanded()).toBe(false)
    expect(document.activeElement).toBe(container.querySelector('.pomodoro-icon'))
    vi.setSystemTime(Date.now() + 42 * 60_000)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(phase()).toBe('breakReady'); expect(timer()).toBeUndefined()
    await click('.pomodoro-yes')
    expect(timer()).toBe('05:00')
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(phase()).toBe('ready')
  })
})

describe('Pomodoro preferences and deadlines', () => {
  it('normalizes invalid persisted durations independently', () => {
    expect(normalizePomodoroSettings(null)).toEqual({ studyMinutes: 40, breakMinutes: 5 })
    expect(normalizePreferences({ pomodoro: { studyMinutes: 50, breakMinutes: 10 } }).pomodoro).toEqual({ studyMinutes: 50, breakMinutes: 10 })
    for (const value of [0, -1, 181, NaN, Infinity, '20', 1.5]) {
      expect(normalizePomodoroSettings({ studyMinutes: value, breakMinutes: 10 })).toEqual({ studyMinutes: 40, breakMinutes: 10 })
    }
    expect(advancePomodoro({ phase: 'study', endsAt: 1_000, breakMinutes: 1 }, 61_000)).toEqual({ phase: 'breakReady', breakMinutes: 1 })
    expect(formatPomodoroTime(60_000, 1)).toBe('01:00')
    expect(formatPomodoroTime(60_000, 61_000)).toBe('00:00')
  })

  it('loads, saves, and reports save failures in Settings', async () => {
    await act(async () => root.render(createElement(PomodoroSettings)))
    const inputs = container.querySelectorAll('input')
    expect(inputs[0]!.value).toBe('40'); expect(inputs[1]!.value).toBe('5')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], '55')
      inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('button[type="submit"]')
    expect(window.opencourse.setPomodoroSettings).toHaveBeenCalledWith({ studyMinutes: 55, breakMinutes: 5 })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved.')
    vi.mocked(window.opencourse.setPomodoroSettings).mockRejectedValueOnce(new Error('Disk full'))
    await click('button[type="submit"]')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Disk full')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
