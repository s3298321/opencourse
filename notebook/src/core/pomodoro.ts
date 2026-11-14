export interface PomodoroSettings {
  studyMinutes: number
  breakMinutes: number
}

export const DEFAULT_POMODORO: PomodoroSettings = { studyMinutes: 40, breakMinutes: 5 }
export const POMODORO_MAX_SECONDS = 180 * 60
export const validPomodoroMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 180
export const validPomodoroSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= POMODORO_MAX_SECONDS

export function normalizePomodoroSettings(raw: unknown): PomodoroSettings {
  const value = raw as Partial<PomodoroSettings> | null
  return {
    studyMinutes: validPomodoroMinutes(value?.studyMinutes) ? value.studyMinutes : DEFAULT_POMODORO.studyMinutes,
    breakMinutes: validPomodoroMinutes(value?.breakMinutes) ? value.breakMinutes : DEFAULT_POMODORO.breakMinutes
  }
}

export type PomodoroCycle =
  | { phase: 'idle' | 'ready' }
  | { phase: 'study'; endsAt: number; breakMinutes: number }
  | { phase: 'breakReady'; breakMinutes: number }
  | { phase: 'break'; endsAt: number }

export interface PomodoroState {
  revision: number
  cycle: PomodoroCycle
}

export interface PomodoroCommand {
  action: 'start' | 'break' | 'stop' | 'dismiss'
  revision: number
  /** Study or break length for this answer only. Anything else leaves the saved length in place. */
  seconds?: number
}

/** Deadlines keep time accurate when the window is hidden or the computer sleeps. */
export function advancePomodoro(cycle: PomodoroCycle, now: number): PomodoroCycle {
  if (cycle.phase === 'study' && now >= cycle.endsAt) {
    return { phase: 'breakReady', breakMinutes: cycle.breakMinutes }
  }
  if (cycle.phase === 'break' && now >= cycle.endsAt) return { phase: 'ready' }
  return cycle
}

export function formatPomodoroTime(endsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1_000))
  return formatPomodoroDuration(seconds)
}

export function formatPomodoroDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** A finished length, from one second through 180 minutes. Incomplete typing is not a length. */
export function parsePomodoroDuration(value: string): number | null {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value)
  if (!match) return null
  const seconds = Number(match[1]) * 60 + Number(match[2])
  return validPomodoroSeconds(seconds) ? seconds : null
}

/** Digits around one colon, while a length is still being typed. */
export function isPomodoroDurationDraft(value: string): boolean {
  if (!/^(?:\d{0,3}|\d{1,3}:\d{0,2})$/.test(value)) return false
  const seconds = value.split(':')[1]
  return seconds === undefined || seconds.length < 2 || Number(seconds) <= 59
}

/** Two minute digits are followed by a colon, so the next digits are seconds. */
export function maskPomodoroDuration(previous: string, next: string): string {
  const minutes = previous.replace(/:/g, '')
  if (/^\d{2}$/.test(next) && next.length > previous.length && next.startsWith(minutes)) return `${next}:`
  return next
}
