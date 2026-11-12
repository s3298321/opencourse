import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_POMODORO, formatPomodoroDuration, formatPomodoroTime, isPomodoroDurationDraft, maskPomodoroDuration, parsePomodoroDuration, validPomodoroSeconds, type PomodoroCommand, type PomodoroSettings, type PomodoroState } from '@core/pomodoro'
import PomodoroIcon from './PomodoroIcon'

/** Mounted in the shared chrome, so navigation never restarts a cycle. */
export default function Pomodoro() {
  const [state, setState] = useState<PomodoroState>({ revision: -1, cycle: { phase: 'idle' } })
  const latest = useRef(state)
  const cycle = state.cycle
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const [prompt, setPrompt] = useState<'start' | 'stop' | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const icon = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const defaults = useRef<PomodoroSettings>(DEFAULT_POMODORO)
  const edited = useRef(false)
  const skipToStart = useRef(false)
  const [breakHeld, setBreakHeld] = useState(false)
  const [template, setTemplate] = useState('')
  const [text, setText] = useState('')

  const receive = useCallback((value: PomodoroState) => {
    if (value.revision < latest.current.revision) return
    if (value.revision !== latest.current.revision) {
      if (panel.current?.contains(document.activeElement)) icon.current?.focus()
      setPrompt(skipToStart.current ? 'start' : null)
      skipToStart.current = false
      setBreakHeld(false)
      setFocused(false)
    }
    latest.current = value
    setState(value)
    setNow(Date.now())
    setError('')
  }, [])

  useEffect(() => {
    let alive = true
    const update = (value: PomodoroState) => { if (alive) receive(value) }
    const refresh = () => { void window.opencourse.getPomodoroState().then(update).catch(err => { if (alive) setError((err as Error).message) }) }
    // Subscribe before reading so a change during the initial request is not lost.
    const unsubscribe = window.opencourse.onPomodoroChanged(update)
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      alive = false
      unsubscribe()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [receive])

  useEffect(() => {
    let alive = true
    void window.opencourse.getPomodoroSettings().then(value => { if (alive) defaults.current = value }).catch(() => {})
    return () => { alive = false }
  }, [])

  const durationKind = cycle.phase === 'breakReady' ? 'break' : cycle.phase === 'ready' || prompt === 'start' ? 'study' : null
  // Keyed by the prompt, not the state object: a refresh copies the cycle and must not wipe an edit.
  const seededLength = cycle.phase === 'breakReady' ? cycle.breakMinutes : null
  const showLength = (totalSeconds: number) => {
    const formatted = formatPomodoroDuration(totalSeconds)
    setTemplate(formatted)
    setText(formatted)
  }
  useLayoutEffect(() => {
    edited.current = false
    if (durationKind === 'break' && seededLength !== null) {
      showLength(seededLength * 60)
      return
    }
    if (durationKind !== 'study') return
    showLength(defaults.current.studyMinutes * 60)
    let alive = true
    void window.opencourse.getPomodoroSettings().then(value => {
      if (!alive || edited.current) return
      defaults.current = value
      showLength(value.studyMinutes * 60)
    }).catch(() => {})
    return () => { alive = false }
  }, [durationKind, seededLength])

  const timed = cycle.phase === 'study' || cycle.phase === 'break'
  useEffect(() => {
    if (!timed) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [timed])

  const command = (kind: PomodoroCommand['action'], seconds?: number) => {
    void window.opencourse.commandPomodoro({
      action: kind, revision: state.revision, ...(validPomodoroSeconds(seconds) ? { seconds } : {})
    }).then(receive).catch(err => setError((err as Error).message))
  }

  const restoreFocus = () => {
    if (panel.current?.contains(document.activeElement)) icon.current?.focus()
  }
  const dismiss = () => {
    restoreFocus()
    setFocused(false)
    if (cycle.phase === 'breakReady') { setBreakHeld(true); return }
    setPrompt(null)
    if (cycle.phase === 'ready') command('dismiss')
  }
  useEffect(() => {
    if (prompt === 'stop' && cycle.phase !== 'study' && cycle.phase !== 'break') setPrompt(null)
  }, [prompt, cycle.phase])

  const stopPrompt = prompt === 'stop' && (cycle.phase === 'study' || cycle.phase === 'break')
  const breakOpen = cycle.phase === 'breakReady' && (!breakHeld || hovered || focused)
  const actionLabel = breakOpen ? 'Start break?' : cycle.phase === 'ready' ? 'Start new session?' : durationKind === 'study' ? 'Start session' : null
  const open = Boolean(actionLabel) || stopPrompt
  const chosen = parsePomodoroDuration(text)
  const ticking = (cycle.phase === 'study' || cycle.phase === 'break') && !stopPrompt
  const lengthValue = actionLabel ? text : ticking && 'endsAt' in cycle ? formatPomodoroTime(cycle.endsAt, now) : ''
  const expanded = open || (ticking && (hovered || focused))
  const label = open ? 'Pomodoro: dismiss confirmation' : cycle.phase === 'study' ? 'Pomodoro: study session in progress. Stop session'
    : cycle.phase === 'break' ? 'Pomodoro: break in progress. Stop session' : 'Pomodoro: start a study session'

  const accept = () => {
    if (durationKind && chosen === null) return
    restoreFocus()
    setPrompt(null)
    setFocused(false)
    if (cycle.phase === 'breakReady') command('break', chosen ?? undefined)
    else if (prompt === 'stop') command('stop')
    else command('start', chosen ?? undefined)
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      const target = event.target
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      if (element?.closest('.pomodoro-icon, .pomodoro-duration, .pomodoro-yes')) return
      dismissRef.current()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [open])
  useEffect(() => {
    if (!stopPrompt || !hovered) return
    const timeout = window.setTimeout(() => dismissRef.current(), 5_000)
    return () => window.clearTimeout(timeout)
  }, [stopPrompt, hovered])

  return <div className="pomodoro" data-phase={cycle.phase} data-expanded={expanded}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); dismiss() } }}>
    <button ref={icon} type="button" className="pomodoro-icon" aria-label={label} aria-expanded={expanded} disabled={state.revision < 0}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setFocused(true) }}
      onClick={() => {
        if (cycle.phase === 'breakReady') { skipToStart.current = true; command('dismiss'); return }
        if (open) { dismiss(); return }
        if (cycle.phase === 'study' || cycle.phase === 'break') setPrompt('stop')
        else if (cycle.phase === 'idle') setPrompt('start')
      }}>
      <PomodoroIcon phase={cycle.phase} />
    </button>
    <div ref={panel} className="pomodoro-panel">
      <PomodoroReveal expanded={expanded}>
        <div className="pomodoro-content">
          {(actionLabel || ticking) && <span className="pomodoro-duration">
            <span className="pomodoro-duration-sizer" aria-hidden="true">{template || lengthValue}</span>
            <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} readOnly={ticking}
              tabIndex={ticking ? -1 : undefined} role={ticking ? 'timer' : undefined}
              aria-invalid={actionLabel ? chosen === null : undefined}
              aria-label={ticking ? (cycle.phase === 'break' ? 'Break time remaining' : 'Study time remaining') : durationKind === 'break' ? 'Break length' : 'Session length'}
              value={lengthValue} onChange={event => {
                if (ticking) return
                const next = maskPomodoroDuration(text, event.target.value)
                if (!isPomodoroDurationDraft(next)) return
                edited.current = true
                setText(next)
                if (next === `${event.target.value}:`) {
                  const input = event.target
                  queueMicrotask(() => input.setSelectionRange(next.length, next.length))
                }
              }}
              onFocus={event => { if (!ticking) event.currentTarget.select() }} onMouseUp={event => { if (!ticking) event.preventDefault() }}
              onKeyDown={event => { if (!ticking && event.key === 'Enter') { event.preventDefault(); accept() } }} />
          </span>}
          {actionLabel && <button type="button" className="pomodoro-yes" onClick={accept} aria-disabled={chosen === null || undefined}>{actionLabel}</button>}
          {ticking && <span className="pomodoro-caption">{cycle.phase === 'break' ? 'Break' : 'Study'}</span>}
          {stopPrompt && <button type="button" className="pomodoro-yes" onClick={accept}>Stop session?</button>}
        </div>
      </PomodoroReveal>
    </div>
    {error && <span role="alert">{error}</span>}
    <span className="sr-only" role="status">{cycle.phase === 'study' ? 'Study session started.' : cycle.phase === 'breakReady' ? 'Start break?' : cycle.phase === 'break' ? 'Break started.' : cycle.phase === 'ready' ? 'Start new session?' : ''}</span>
  </div>
}

/** Keep the outgoing content in place until it has folded behind the icon.
 * Pixel widths animate in both directions even when the content changes size;
 * an intrinsic grid track can collapse instantly when its children change. */
function PomodoroReveal({ expanded, children, className = '' }: { expanded: boolean; children: ReactNode; className?: string }) {
  const [retained, setRetained] = useState(children)
  const [width, setWidth] = useState(0)
  const [visible, setVisible] = useState(expanded)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (expanded) setRetained(children)
  }, [expanded, children])
  useLayoutEffect(() => {
    if (expanded) {
      setVisible(true)
      return
    }
    const timeout = window.setTimeout(() => setVisible(false), 320)
    return () => window.clearTimeout(timeout)
  }, [expanded])
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <div className={`pomodoro-reveal ${className}`} data-visible={visible} style={{ width: expanded ? width : 0 }}
    inert={!expanded} aria-hidden={!expanded}>
    <div className="pomodoro-reveal-inner" ref={content}>{expanded ? children : retained}</div>
  </div>
}
