import type { PomodoroCycle } from '@core/pomodoro'

export default function PomodoroIcon({ phase }: { phase: PomodoroCycle['phase'] }) {
  const state = phase === 'study' ? 'running' : phase === 'break' ? 'paused' : 'idle'
  return <span className="pomodoro-clock" data-state={state} aria-hidden="true">
    <svg width="100%" height="100%" viewBox="0 0 100 100" stroke="currentColor" strokeWidth="12" strokeLinecap="round">
      {state === 'paused' ? <path d="M39 37v26 M61 37v26" /> : <>
        <line className="pomodoro-clock-hand pomodoro-clock-minute" x1="50" y1="50" x2="50" y2="32" />
        <line className="pomodoro-clock-hand pomodoro-clock-hour" x1="50" y1="50" x2="50" y2="34" />
      </>}
    </svg>
  </span>
}
