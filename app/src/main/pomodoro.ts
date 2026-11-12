import { advancePomodoro, validPomodoroSeconds, type PomodoroCommand, type PomodoroCycle, type PomodoroSettings, type PomodoroState } from '../core/pomodoro'

/** One clock owned by main, independent of renderer lifetimes and throttling. */
export class PomodoroTimer {
  private state: PomodoroState = { revision: 0, cycle: { phase: 'idle' } }
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(private settings: () => PomodoroSettings, private changed: (state: PomodoroState) => void) {}

  get(): PomodoroState {
    const cycle = advancePomodoro(this.state.cycle, Date.now())
    if (cycle !== this.state.cycle) this.publish(cycle)
    return this.state
  }

  command(command: PomodoroCommand): PomodoroState {
    const { cycle, revision } = this.get()
    // Two windows can answer the same prompt. Only the first answer applies.
    if (!command || command.revision !== revision) return this.state
    const seconds = validPomodoroSeconds(command.seconds) ? command.seconds : undefined
    if (command.action === 'start' && (cycle.phase === 'idle' || cycle.phase === 'ready')) {
      const settings = this.settings()
      this.publish({ phase: 'study', endsAt: Date.now() + (seconds ?? settings.studyMinutes * 60) * 1_000, breakMinutes: settings.breakMinutes })
    } else if (command.action === 'break' && cycle.phase === 'breakReady') {
      this.publish({ phase: 'break', endsAt: Date.now() + (seconds ?? cycle.breakMinutes * 60) * 1_000 })
    } else if ((command.action === 'stop' && (cycle.phase === 'study' || cycle.phase === 'break')) ||
      (command.action === 'dismiss' && (cycle.phase === 'ready' || cycle.phase === 'breakReady'))) {
      this.publish({ phase: 'idle' })
    }
    return this.state
  }

  reset(): void { this.publish({ phase: 'idle' }) }

  private publish(cycle: PomodoroCycle): void {
    clearTimeout(this.timeout)
    this.timeout = undefined
    this.state = { revision: this.state.revision + 1, cycle }
    if ('endsAt' in cycle) this.timeout = setTimeout(() => this.get(), Math.max(0, cycle.endsAt - Date.now()))
    this.changed(this.state)
  }
}
