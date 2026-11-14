import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PomodoroTimer } from '../src/main/pomodoro'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000) })
afterEach(() => vi.useRealTimers())
const setup = () => {
  const changed = vi.fn()
  const settings = { studyMinutes: 1, breakMinutes: 2 }
  return { changed, settings, timer: new PomodoroTimer(() => settings, changed) }
}

it('publishes deadlines without a renderer, and keeps the configured break for the active cycle', () => {
  const { timer, changed, settings } = setup()
  timer.command({ action: 'start', revision: 0 })
  expect(timer.get().cycle).toEqual({ phase: 'study', endsAt: 61_000, breakMinutes: 2 })
  settings.studyMinutes = 3; settings.breakMinutes = 4
  vi.advanceTimersByTime(60_000)
  expect(changed).toHaveBeenLastCalledWith({ revision: 2, cycle: { phase: 'breakReady', breakMinutes: 2 } })
  vi.advanceTimersByTime(600_000)
  timer.command({ action: 'break', revision: 2 })
  expect(timer.get().cycle).toEqual({ phase: 'break', endsAt: 781_000 })
  vi.advanceTimersByTime(120_000)
  expect(changed).toHaveBeenLastCalledWith({ revision: 4, cycle: { phase: 'ready' } })
  expect(timer.command({ action: 'start', revision: 4 }).cycle).toEqual({ phase: 'study', endsAt: 961_000, breakMinutes: 4 })
})

it('ignores duplicate and stale answers from other windows', () => {
  const { timer } = setup()
  const first = timer.command({ action: 'start', revision: 0 })
  expect(timer.command({ action: 'start', revision: 0 })).toBe(first)
  vi.advanceTimersByTime(60_000)
  const invitation = timer.get()
  // A stop confirmation left open in another window cannot dismiss the next phase.
  expect(timer.command({ action: 'stop', revision: first.revision })).toBe(invitation)
  const rest = timer.command({ action: 'break', revision: invitation.revision })
  expect(timer.command({ action: 'dismiss', revision: invitation.revision })).toBe(rest)
  timer.reset()
  expect(timer.command({ action: 'start', revision: rest.revision }).cycle.phase).toBe('idle')
  vi.advanceTimersByTime(120_000)
  expect(timer.get().cycle.phase).toBe('idle')
})

it('honours a one-off length and ignores a length outside 1 second–180 minutes', () => {
  const { timer } = setup()
  expect(timer.command({ action: 'start', revision: 0, seconds: 12 * 60 }).cycle).toEqual({
    phase: 'study', endsAt: 721_000, breakMinutes: 2
  })
  vi.advanceTimersByTime(12 * 60_000)
  expect(timer.command({ action: 'break', revision: 2, seconds: 90 }).cycle).toEqual({ phase: 'break', endsAt: 811_000 })
  vi.advanceTimersByTime(90_000)
  expect(timer.command({ action: 'start', revision: 4, seconds: 1.5 }).cycle).toEqual({
    phase: 'study', endsAt: 871_000, breakMinutes: 2
  })
})

it('catches up on resume and rejects an action based on a deadline that passed during sleep', () => {
  const { timer, changed } = setup()
  timer.command({ action: 'start', revision: 0 })
  vi.setSystemTime(600_000)
  expect(timer.command({ action: 'stop', revision: 1 }).cycle.phase).toBe('breakReady')
  expect(changed).toHaveBeenCalledTimes(2)
})
