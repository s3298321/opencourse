import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advancePomodoro, formatPomodoroDuration, formatPomodoroTime, isPomodoroDurationDraft, maskPomodoroDuration, normalizePomodoroSettings, parsePomodoroDuration } from '../src/core/pomodoro'
import { PomodoroTimer } from '../src/main/pomodoro'
import type { PomodoroState } from '../src/core/pomodoro'
import { normalizePreferences } from '../src/core/preferences'
import Pomodoro from '../src/renderer/components/Pomodoro'
import PomodoroSettings from '../src/renderer/components/PomodoroSettings'
import { TitleBarChrome } from '../src/renderer/components/TitleBar'
vi.mock('../src/renderer/components/useAppUpdate', () => ({ useAppUpdate: () => null }))

let service: PomodoroTimer
let listeners: Set<(state: PomodoroState) => void>
let settings: { studyMinutes: number; breakMinutes: number }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  listeners = new Set()
  settings = { studyMinutes: 40, breakMinutes: 5 }
  service = new PomodoroTimer(() => settings, state => listeners.forEach(listener => listener(state)))
  vi.stubGlobal('opencourse', {
    getPomodoroState: vi.fn(async () => service.get()),
    commandPomodoro: vi.fn(async command => service.command(command)),
    onPomodoroChanged: vi.fn(handler => { listeners.add(handler); return () => { listeners.delete(handler) } }),
    getPomodoroSettings: vi.fn(async () => settings),
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
const timer = async () => {
  const wasExpanded = expanded()
  if (!wasExpanded) await hover(true)
  const value = container.querySelector<HTMLInputElement>('[role="timer"]')?.value
  if (!wasExpanded) await hover(false)
  return value
}
const hover = async (on: boolean) => act(async () => {
  container.querySelector('.pomodoro')!.dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: document.body }))
})
const start = async () => { await click('.pomodoro-icon'); await click('.pomodoro-yes') }
const outside = async () => act(async () => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const typeDuration = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>('.pomodoro-duration input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Pomodoro title bar', () => {
  it('retains outgoing prompts while folding and keeps them inert', async () => {
    await render(); await click('.pomodoro-icon'); await outside()
    const reveal = container.querySelector('.pomodoro > div > .pomodoro-reveal')!
    expect(expanded()).toBe(false)
    expect(reveal.textContent).toContain('Start session')
    expect(reveal.hasAttribute('inert')).toBe(true)
    expect(reveal.getAttribute('data-visible')).toBe('true')
    await advance(320)
    expect(reveal.getAttribute('data-visible')).toBe('false')
    await start(); await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(phase()).toBe('idle')
    expect(reveal.textContent).toContain('Stop session?')
    // Reopening during a close cancels its cleanup and restores current actions.
    await advance(100); await click('.pomodoro-icon'); await advance(320)
    expect(reveal.getAttribute('data-visible')).toBe('true')
    expect(reveal.textContent).toContain('Start session')
  })

  it('continues across navigation and resets when switching users', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const user = { id: 'first', name: 'Learner', color: '#999', createdAt: '' }
    await act(async () => root.render(createElement(TitleBarChrome, { user, route: { name: 'library' } })))
    await start(); await advance(5_000)
    const control = container.querySelector('.pomodoro')
    await act(async () => root.render(createElement(TitleBarChrome, { user, route: { name: 'documents' } })))
    expect(container.querySelector('.pomodoro')).toBe(control)
    expect(phase()).toBe('study')
    await hover(false); await hover(true)
    expect(await timer()).toBe('39:55')
    await act(async () => { service.reset(); root.render(createElement(TitleBarChrome, { user: { ...user, id: 'second' }, route: { name: 'library' } })) })
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
  })

  it('edits the length for this session and this break without saving it', async () => {
    await render(); await click('.pomodoro-icon')
    const field = () => container.querySelector<HTMLInputElement>('.pomodoro-duration input')!
    expect(field().value).toBe('40:00')
    expect(field().getAttribute('aria-label')).toBe('Session length')
    expect(container.querySelector('.pomodoro-duration-sizer')?.textContent).toBe('40:00')
    expect(container.querySelector('.pomodoro-yes')?.textContent).toBe('Start session')
    const input = field()
    await act(async () => input.focus())
    const typeChar = async (char: string) => {
      await act(async () => {
        const start = input.selectionStart ?? input.value.length
        const end = input.selectionEnd ?? start
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
        proto.set!.call(input, input.value.slice(0, start) + char + input.value.slice(end))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      input.setSelectionRange(input.value.length, input.value.length)
    }
    await typeChar('2')
    expect(input.value).toBe('2')
    await typeChar('5')
    expect(input.value).toBe('25:')
    await typeChar('3')
    expect(input.value).toBe('25:3')
    await typeChar('0')
    expect(input.value).toBe('25:30')
    expect(container.querySelector('.pomodoro-duration-sizer')?.textContent).toBe('40:00')
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(await timer()).toBe('25:30')
    expect(phase()).toBe('study')
    expect(window.opencourse.setPomodoroSettings).not.toHaveBeenCalled()
    await advance(25 * 60_000 + 30_000)
    expect(field().value).toBe('05:00')
    expect(field().getAttribute('aria-label')).toBe('Break length')
    expect(container.querySelector('.pomodoro-duration-sizer')?.textContent).toBe('05:00')
    expect(container.querySelector('.pomodoro-yes')?.textContent).toBe('Start break?')
    await typeDuration('0:00')
    expect(container.querySelector('.pomodoro-yes')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(phase()).toBe('breakReady')
    await typeDuration('3:00')
    expect(container.querySelector('.pomodoro-yes')?.hasAttribute('aria-disabled')).toBe(false)
    await click('.pomodoro-yes')
    expect(phase()).toBe('break')
    expect(await timer()).toBe('03:00')
    await advance(3 * 60_000)
    expect(field().value).toBe('40:00')
    expect(container.querySelector('.pomodoro-yes')?.textContent).toBe('Start new session?')
    await click('.pomodoro-yes')
    expect(await timer()).toBe('40:00')
  })

  it('asks before starting, keeps the countdown hidden until hover, and hides it again', async () => {
    await render()
    expect(expanded()).toBe(false)
    await click('.pomodoro-icon')
    expect(container.textContent).toContain('Start session')
    await act(async () => container.querySelector('.pomodoro-duration input')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(expanded()).toBe(true)
    await outside()
    expect(expanded()).toBe(false)
    expect(phase()).toBe('idle')
    await click('.pomodoro-icon')
    expect(expanded()).toBe(true)
    await click('.pomodoro-icon')
    expect(expanded()).toBe(false)
    expect(phase()).toBe('idle')
    expect(container.querySelector('.pomodoro > div > .pomodoro-reveal')?.hasAttribute('inert')).toBe(true)
    await start()
    expect(expanded()).toBe(false)
    expect(await timer()).toBe('40:00')
    expect(container.querySelector('.pomodoro-duration')?.nextElementSibling?.textContent).toBe('Study')
    expect(phase()).toBe('study')
    await advance(1_000)
    expect(await timer()).toBe('39:59')
    expect(expanded()).toBe(false)
    await hover(true)
    expect(expanded()).toBe(true)
    await hover(false)
    expect(expanded()).toBe(false)
  })

  it('closes stop confirmation from the clock, a click outside, or five seconds of hovering', async () => {
    await render(); await start()
    await hover(true)
    expect(expanded()).toBe(true)
    expect(container.querySelector('.pomodoro-caption')?.textContent).toBe('Study')
    await hover(false)
    expect(expanded()).toBe(false)
    await click('.pomodoro-icon')
    expect(container.textContent).toContain('Stop session?')
    await advance(10_000)
    expect(expanded()).toBe(true)
    expect(phase()).toBe('study')
    await hover(true)
    await advance(4_900)
    expect(expanded()).toBe(true)
    await hover(false)
    await advance(5_000)
    expect(container.textContent).toContain('Stop session?')
    await hover(true)
    await advance(5_000)
    expect(expanded()).toBe(true)
    expect(container.querySelector('.pomodoro-caption')?.textContent).toBe('Study')
    await hover(false)
    await click('.pomodoro-icon'); await outside()
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
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Start break?')
    expect(await timer()).toBeUndefined()
    expect(expanded()).toBe(true)
    await advance(60 * 60_000)
    expect(phase()).toBe('breakReady')
    expect(expanded()).toBe(true)
    await click('.pomodoro-yes')
    expect(phase()).toBe('break'); expect(await timer()).toBe('05:00'); expect(expanded()).toBe(false)
    await hover(true)
    expect(expanded()).toBe(true)
    expect(container.querySelector('.pomodoro-caption')?.textContent).toBe('Break')
    await hover(false)
    await advance(3_000)
    expect(await timer()).toBe('04:57')
    expect(expanded()).toBe(false)
    await advance(5 * 60_000 - 3_000)
    expect(phase()).toBe('ready')
    expect(container.textContent).toContain('Start new session?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('study'); expect(await timer()).toBe('40:00')
    await advance(40 * 60_000); await click('.pomodoro-yes'); await advance(5 * 60_000)
    await outside()
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
  })

  it.each(['outside', 'Escape'])('keeps the break invitation when it is wrapped with %s', async method => {
    await render(); await start(); await advance(40 * 60_000)
    if (method === 'Escape') {
      await act(async () => container.querySelector('.pomodoro')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    } else await outside()
    expect(phase()).toBe('breakReady'); expect(expanded()).toBe(false)
    expect(container.querySelector('.pomodoro-reveal')?.hasAttribute('inert')).toBe(true)
    await advance(10 * 60_000)
    expect(phase()).toBe('breakReady')
    await hover(true)
    expect(expanded()).toBe(true)
    expect(container.querySelector('.pomodoro-yes')?.textContent).toBe('Start break?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('break')
  })

  it('opens the start screen when the clock is clicked during the break invitation', async () => {
    await render(); await start(); await advance(40 * 60_000)
    await outside()
    expect(phase()).toBe('breakReady')
    await click('.pomodoro-icon')
    expect(phase()).toBe('idle')
    expect(expanded()).toBe(true)
    expect(container.querySelector('.pomodoro-yes')?.textContent).toBe('Start session')
    await click('.pomodoro-yes')
    expect(await timer()).toBe('40:00')
  })

  it('replaces an expiring study stop prompt with the break invitation', async () => {
    await render(); await start(); await advance(40 * 60_000 - 1_000)
    await click('.pomodoro-icon'); await advance(1_000)
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Start break?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('break'); expect(await timer()).toBe('05:00')
  })

  it('can dismiss, time out, or confirm stopping during a break', async () => {
    await render(); await start(); await advance(40 * 60_000); await click('.pomodoro-yes'); await advance(3_000)
    expect(expanded()).toBe(false)
    await hover(true)
    expect(await timer()).toBe('04:57')
    await hover(false)
    await click('.pomodoro-icon')
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Stop session?')
    await outside()
    expect(phase()).toBe('break'); expect(expanded()).toBe(false)
    await click('.pomodoro-icon')
    await hover(true)
    await advance(5_000)
    expect(phase()).toBe('break')
    expect(container.querySelector('.pomodoro-caption')?.textContent).toBe('Break')
    await hover(false)
    await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(phase()).toBe('idle'); expect(expanded()).toBe(false)
    await advance(10 * 60_000)
    expect(phase()).toBe('idle')
    await start()
    expect(phase()).toBe('study'); expect(await timer()).toBe('40:00')
  })

  it('offers another session if the break ends during stop confirmation', async () => {
    settings = { studyMinutes: 1, breakMinutes: 1 }
    await render(); await start(); await advance(60_000); await click('.pomodoro-yes'); await advance(59_000)
    await click('.pomodoro-icon'); await advance(1_000)
    expect(phase()).toBe('ready')
    expect(container.querySelector('.pomodoro-content')?.textContent).toContain('Start new session?')
    await click('.pomodoro-yes')
    expect(phase()).toBe('study'); expect(await timer()).toBe('01:00')
  })

  it('applies changed durations to the next cycle without changing an active one', async () => {
    await render(); await start()
    settings = { studyMinutes: 1, breakMinutes: 2 }
    expect(await timer()).toBe('40:00')
    await advance(40 * 60_000); await click('.pomodoro-yes')
    expect(await timer()).toBe('05:00')
    await advance(5 * 60_000); await click('.pomodoro-yes')
    expect(await timer()).toBe('01:00')
    await advance(60_000); await click('.pomodoro-yes')
    expect(await timer()).toBe('02:00')
  })

  it('catches up after suspension, handles Escape, and returns keyboard focus on dismissal', async () => {
    await render(); await start(); await advance(3_000); await click('.pomodoro-icon')
    const yes = container.querySelector<HTMLButtonElement>('.pomodoro-yes')!
    await act(async () => { yes.focus(); yes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(expanded()).toBe(false)
    expect(document.activeElement).toBe(container.querySelector('.pomodoro-icon'))
    vi.setSystemTime(Date.now() + 42 * 60_000)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(phase()).toBe('breakReady'); expect(await timer()).toBeUndefined()
    await click('.pomodoro-yes')
    expect(await timer()).toBe('05:00')
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
    expect(formatPomodoroDuration(90)).toBe('01:30')
    expect(parsePomodoroDuration('25:30')).toBe(1_530)
    expect(parsePomodoroDuration('180:00')).toBe(10_800)
    for (const value of ['0:00', '180:01', '25', '25:60', '4:5']) expect(parsePomodoroDuration(value)).toBeNull()
    expect(isPomodoroDurationDraft('25:')).toBe(true)
    expect(isPomodoroDurationDraft('4:5')).toBe(true)
    expect(isPomodoroDurationDraft('25:60')).toBe(false)
    expect(maskPomodoroDuration('4', '40')).toBe('40:')
    expect(maskPomodoroDuration('40:00', '2')).toBe('2')
    expect(maskPomodoroDuration('40:', '40')).toBe('40')
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


it('synchronizes two mounted windows and reconnects after one closes', async () => {
  await render(); await start(); await advance(5_000)
  const other = document.body.appendChild(document.createElement('div'))
  const otherRoot = createRoot(other)
  const otherClick = async (selector: string) => act(async () => other.querySelector<HTMLButtonElement>(selector)!.click())
  try {
    await act(async () => otherRoot.render(createElement(Pomodoro)))
    await act(async () => other.querySelector('.pomodoro')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
    expect(other.querySelector<HTMLInputElement>('[role="timer"]')?.value).toBe('39:55')
    await otherClick('.pomodoro-icon'); await otherClick('.pomodoro-yes')
    expect(phase()).toBe('idle')
    await start()
    expect(other.querySelector('.pomodoro')?.getAttribute('data-phase')).toBe('study')
    await advance(40 * 60_000)
    expect(other.textContent).toContain('Start break?')
    await otherClick('.pomodoro-yes')
    expect(phase()).toBe('break'); expect(await timer()).toBe('05:00')
    await act(async () => root.render(null))
    expect(listeners.size).toBe(1)
    await advance(30_000)
    await render()
    expect(phase()).toBe('break'); expect(await timer()).toBe('04:30')
    await click('.pomodoro-icon'); await click('.pomodoro-yes')
    expect(other.querySelector('.pomodoro')?.getAttribute('data-phase')).toBe('idle')
  } finally {
    await act(async () => otherRoot.unmount())
    other.remove()
  }
})

it('does not overwrite a broadcast with an older initial response', async () => {
  let resolve!: (state: PomodoroState) => void
  vi.mocked(window.opencourse.getPomodoroState).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await render()
  await act(async () => { service.command({ action: 'start', revision: 0 }) })
  await act(async () => resolve({ revision: 0, cycle: { phase: 'idle' } }))
  expect(phase()).toBe('study')
  expect(await timer()).toBe('40:00')
})
