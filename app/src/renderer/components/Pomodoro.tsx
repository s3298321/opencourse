import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatPomodoroTime, type PomodoroCommand, type PomodoroState } from '@core/pomodoro'
import PomodoroIcon from './PomodoroIcon'

/** Mounted in the shared chrome, so navigation never restarts a cycle. */
export default function Pomodoro() {
  const [state, setState] = useState<PomodoroState>({ revision: -1, cycle: { phase: 'idle' } })
  const latest = useRef(state)
  const cycle = state.cycle
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const [prompt, setPrompt] = useState<'start' | 'stop' | null>(null)
  const [previewUntil, setPreviewUntil] = useState(0)
  const [stopUntil, setStopUntil] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [suppressPeek, setSuppressPeek] = useState(false)
  const icon = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const receive = useCallback((value: PomodoroState) => {
    if (value.revision < latest.current.revision) return
    if (value.revision !== latest.current.revision) {
      if (panel.current?.contains(document.activeElement)) icon.current?.focus()
      setPrompt(null)
      setSuppressPeek(true)
      setFocused(false)
      setPreviewUntil(value.cycle.phase === 'study' ? Date.now() + 3_000 : 0)
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

  const timed = cycle.phase === 'study' || cycle.phase === 'break'
  useEffect(() => {
    if (!timed) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [timed])

  const command = (action: PomodoroCommand['action']) => {
    void window.opencourse.commandPomodoro({ action, revision: state.revision }).then(receive).catch(err => setError((err as Error).message))
  }

  const restoreFocus = () => {
    if (panel.current?.contains(document.activeElement)) icon.current?.focus()
  }
  const dismiss = () => {
    restoreFocus()
    setPrompt(null)
    setPreviewUntil(0)
    setSuppressPeek(true)
    setFocused(false)
    if (cycle.phase === 'ready' || cycle.phase === 'breakReady') command('dismiss')
  }
  useEffect(() => {
    if (prompt === 'stop' && (now >= stopUntil || (cycle.phase !== 'study' && cycle.phase !== 'break'))) {
      restoreFocus()
      setPrompt(null)
      setPreviewUntil(0)
      setSuppressPeek(true)
      setFocused(false)
    }
  }, [now, stopUntil, prompt, cycle.phase])

  const question = cycle.phase === 'breakReady' ? "Time's up ! Start break ?" : cycle.phase === 'ready' ? 'Start another session ?'
    : prompt === 'stop' ? 'Stop session ?' : prompt === 'start' ? 'Start a study session ?' : null
  const expanded = Boolean(question) || cycle.phase === 'break' ||
    (cycle.phase === 'study' && (now < previewUntil || (!suppressPeek && (hovered || focused))))
  const label = question ? 'Pomodoro: dismiss confirmation' : cycle.phase === 'study' ? 'Pomodoro: study session in progress. Stop session'
    : cycle.phase === 'break' ? 'Pomodoro: break in progress. Stop session' : 'Pomodoro: start a study session'

  const accept = () => {
    restoreFocus()
    setPrompt(null)
    setSuppressPeek(true)
    setFocused(false)
    if (cycle.phase === 'breakReady') command('break')
    else if (prompt === 'stop') command('stop')
    else command('start')
  }

  return <div className="pomodoro" data-phase={cycle.phase} data-expanded={expanded}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setSuppressPeek(false) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setSuppressPeek(false) } }}
    onKeyDown={event => { if (event.key === 'Escape' && question) { event.preventDefault(); dismiss() } }}>
    <button ref={icon} type="button" className="pomodoro-icon" aria-label={label} aria-expanded={expanded} disabled={state.revision < 0}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) { setFocused(true); setSuppressPeek(false) } }}
      onClick={() => {
        if (question) { dismiss(); return }
        const time = Date.now()
        setNow(time)
        if (cycle.phase === 'study' || cycle.phase === 'break') { setPrompt('stop'); setStopUntil(time + 10_000) }
        else if (cycle.phase === 'idle') setPrompt('start')
      }}>
      <PomodoroIcon phase={cycle.phase} />
    </button>
    <div ref={panel} className="pomodoro-panel">
      <PomodoroReveal expanded={expanded}>
        <div className="pomodoro-content">
          {question ? <>
            <span>{question}</span>
            <button type="button" className="pomodoro-yes" onClick={accept}>Yes</button>
            <button type="button" className="pomodoro-no" onClick={dismiss}>No</button>
          </> : <>
            <span className="pomodoro-caption">{cycle.phase === 'break' ? 'Break' : 'Study'}</span>
            <span className="pomodoro-time" role="timer" aria-label={cycle.phase === 'break' ? 'Break time remaining' : 'Study time remaining'}>
              {'endsAt' in cycle ? formatPomodoroTime(cycle.endsAt, now) : ''}
            </span>
          </>}
        </div>
      </PomodoroReveal>
    </div>
    {error && <span role="alert">{error}</span>}
    <span className="sr-only" role="status">{cycle.phase === 'study' ? 'Study session started.' : cycle.phase === 'breakReady' ? "Time's up! Start break?" : cycle.phase === 'break' ? 'Break started.' : cycle.phase === 'ready' ? 'Break finished. Start another session?' : ''}</span>
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
