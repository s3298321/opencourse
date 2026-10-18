export interface PomodoroSettings {
  studyMinutes: number
  breakMinutes: number
}

export const DEFAULT_POMODORO: PomodoroSettings = { studyMinutes: 40, breakMinutes: 5 }
export const validPomodoroMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 180

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
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
