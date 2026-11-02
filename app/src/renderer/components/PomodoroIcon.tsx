import type { PomodoroCycle } from '@core/pomodoro'

export default function PomodoroIcon({ phase }: { phase: PomodoroCycle['phase'] }) {
  const state = phase === 'study' ? 'running' : phase === 'break' ? 'paused' : 'idle'
  return <span className="pomodoro-clock" data-state={state} aria-hidden="true">
    <span className="pomodoro-clock-hand pomodoro-clock-minute" />
    <span className="pomodoro-clock-hand pomodoro-clock-hour" />
  </span>
}
