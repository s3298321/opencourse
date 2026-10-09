import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CoachProject } from '@core/types'
import { atBottom } from '@core/coach/scroll'
import { MAX_SESSION_MS, RealtimeSession, type SessionView } from '../coach/realtime'

/**
 * The live panel: start, talk, stop.
 *
 * The session itself lives in a ref, because a peer connection and a microphone
 * must not be re-created when React re-renders. Only a coarse snapshot is mirrored
 * into state, on a throttle - the transcript arrives a few characters at a time
 * and setState per delta would spend the whole frame budget on re-renders.
 */

/** How often the screen catches up with the conversation. */
const TICK_MS = 150

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function statusLine(view: SessionView): { text: string; tone: '' | ' live' | ' error' } {
  switch (view.status.kind) {
    case 'idle':
      return { text: 'Ready when you are.', tone: '' }
    case 'connecting':
      return { text: 'Connecting…', tone: '' }
    case 'live':
      return { text: view.speaking ? 'Coach is speaking' : view.responding ? 'Coach is thinking…' : 'Listening', tone: ' live' }
    case 'wrapping-up':
      return { text: view.status.note, tone: '' }
    case 'ended':
      return { text: 'Session ended.', tone: '' }
    case 'lost':
      return { text: 'The connection dropped.', tone: ' error' }
    case 'mic-denied':
      return { text: 'OpenCourse cannot hear you.', tone: ' error' }
    case 'error':
      return { text: view.status.message, tone: ' error' }
  }
}

export default function CoachSession({
  project,
  onSessionChanged
}: {
  project: CoachProject
  onSessionChanged: () => void
}): JSX.Element {
  const session = useRef<RealtimeSession | null>(null)
  const dirty = useRef(false)
  const [view, setView] = useState<SessionView | null>(null)
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [stopRequested, setStopRequested] = useState(false)
  // The transcript window follows what is being said, the way a terminal
  // follows output - until you scroll up to re-read something, which is a
  // request to be left alone. The button is then the only thing that moves it.
  const scroller = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  // The same answer as `following`, written where the scroll handler writes
  // it rather than a render later. A tick landing in the gap between the
  // reader scrolling up and React flushing that state would otherwise yank
  // them back down once, which is exactly the thing this is here to stop.
  const followingNow = useRef(true)
  const follow = useCallback((next: boolean) => {
    followingNow.current = next
    setFollowing(next)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && followingNow.current) el.scrollTop = el.scrollHeight
  }, [view, following])

  // Our own scroll above lands at the bottom and re-arms this, so the flag
  // stays true through every tick we caused.
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (el) follow(atBottom(el))
  }, [follow])

  // One timer, not one render per delta.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!session.current) return
      // The clock has to keep moving even when nothing is being said.
      if (!dirty.current && session.current.view().status.kind !== 'live') return
      dirty.current = false
      setView(session.current.view())
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // StrictMode double-invokes effects, and an abandoned session must not keep
  // a microphone open.
  useEffect(() => {
    return () => {
      session.current?.abandon()
      session.current = null
    }
  }, [])

  // A window closing mid-session cannot await, so this is best effort. Main's
  // watchSender is what actually guarantees the row gets closed.
  useEffect(() => {
    const onUnload = (): void => session.current?.abandon()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const start = useCallback(async () => {
    if (session.current || starting) return
    setStarting(true)
    setProblem(null)
    setStopRequested(false)
    try {
      const result = await window.opencourse.startCoachSession(project.id)
      if (result.status === 'no-key') {
        setProblem('Add your OpenAI key in Settings before starting a session.')
        return
      }
      if (result.status === 'mic-denied') {
        setProblem('macOS is not letting OpenCourse use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.')
        return
      }
      if (result.status === 'failed') {
        setProblem(result.message)
        return
      }

      const live = new RealtimeSession(result, () => {
        dirty.current = true
      })
      session.current = live
      setView(live.view())
      await live.start()
      setView(live.view())
      onSessionChanged()
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setStarting(false)
    }
  }, [project.id, starting, onSessionChanged])

  const stop = useCallback(async () => {
    const live = session.current
    if (!live) return
    // A second click means "stop now" - do not wait out the wrap-up.
    const skipWrapUp = stopRequested
    setStopRequested(true)
    await live.stop(skipWrapUp ? { skipWrapUp: true } : {})
    setView(live.view())
    session.current = null
    onSessionChanged()
  }, [stopRequested, onSessionChanged])

  const running = view !== null && ['connecting', 'live', 'wrapping-up'].includes(view.status.kind)
  const line = view ? statusLine(view) : { text: 'Ready when you are.', tone: '' as const }
  const nearCap = view ? view.elapsedMs > MAX_SESSION_MS * 0.9 : false

  return (
    <div className="panel coach-live">
      <div className="live-head">
        <div className={`live-status${line.tone}`}>
          {running && <span className="live-dot" />}
          <span>{line.text}</span>
          {view && running && <span className="meta live-clock">{clock(view.elapsedMs)}</span>}
        </div>

        {running ? (
          <div className="actions">
            {view?.status.kind === 'live' && (view.speaking || view.responding) && (
              <button className="secondary coach-interrupt" onClick={() => session.current?.interrupt()}>
                Stop speaking
              </button>
            )}
            <button className="secondary" onClick={() => void stop()}>
              {stopRequested ? 'Stop now' : 'Finish session'}
            </button>
          </div>
        ) : (
          <button disabled={starting} onClick={() => void start()}>
            {starting ? 'Starting' : 'Start a session'}
          </button>
        )}
      </div>

      {problem && <p className="import-note error">{problem}</p>}
      {nearCap && running && (
        <p className="import-note">This session is near the 45-minute limit and will wrap itself up soon.</p>
      )}

      {!view && !problem && (
        <p className="meta">
          Talk to your coach. It listens, answers out loud, and keeps its own notes in the workspace below —
          you can read them but not edit them. Sessions are transcribed and kept on this Mac.
        </p>
      )}

      {view && view.activity.length > 0 && (
        <div className="live-activity">
          {view.activity.map((entry) => (
            <span key={entry.id} className={`tool-chip${entry.ok ? '' : ' failed'}`}>
              {entry.text}
            </span>
          ))}
        </div>
      )}

      {view && (view.turns.length > 0 || view.partial) && (
        <div className="transcript-window">
          <div className="transcript live" ref={scroller} onScroll={onScroll}>
            {view.turns.map((turn) => (
              <p key={`${turn.seq}`} className={`turn ${turn.role}`}>
                {turn.text}
              </p>
            ))}
            {view.partial && <p className={`turn ${view.partial.role} partial`}>{view.partial.text}</p>}
          </div>
          {!following && (
            <button
              className="transcript-latest"
              onClick={() => follow(true)}
              title="Follow the conversation again"
            >
              ↓ Latest
            </button>
          )}
        </div>
      )}

      {/*
        Only genuinely unrecognised events get here. The bookkeeping a normal
        session produces is counted separately and never shown - an alarm that
        fires every time is not an alarm.
      */}
      {view && Object.keys(view.unknown).length > 0 && (
        <details className="live-diagnostics">
          <summary className="meta">Unrecognised events ({Object.keys(view.unknown).length} kinds)</summary>
          <p className="meta">
            OpenCourse did not know what to do with these. The conversation is unaffected, but a transcript line
            may be missing — this usually means OpenAI renamed something.
          </p>
          <pre className="coach-file-text">
            {Object.entries(view.unknown)
              .map(([type, count]) => `${count}× ${type}`)
              .join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
