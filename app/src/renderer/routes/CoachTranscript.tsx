import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CoachTranscript as Transcript, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'

interface Props {
  projectId: string
  sessionId: string
  user: UserProfile | null
  navigate: (r: Route) => void
  route: Screen
}

function when(iso: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/**
 * One past session, read back.
 *
 * The brief shown here is the one that was snapshotted when the session ran,
 * not the project's current one - otherwise an old transcript would be
 * explained by a coach it never had.
 */
export default function CoachTranscript({ projectId, sessionId, user, navigate, route }: Props): JSX.Element {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.opencourse.getCoachTranscript(sessionId).then((found) => {
      if (cancelled) return
      if (found) setTranscript(found)
      else setMissing(true)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const back = { label: 'Back to the coach', onClick: () => navigate({ name: 'coachProject', projectId }) }

  if (missing) {
    return (
      <>
        <TitleBar user={user} navigate={navigate} route={route} back={back} />
        <div className="body">
          <div className="content scroll">
            <div className="empty">That session is gone.</div>
          </div>
        </div>
      </>
    )
  }

  if (!transcript) return <div className="empty">Loading…</div>

  const { session, turns, toolCalls } = transcript

  return (
    <>
      <TitleBar user={user} navigate={navigate} route={route} back={back} />
      <div className="body">
        <div className="content scroll">
          <div className="coach-project">
            <div className="library-head">
              <div>
                <h1>{when(session.startedAt)}</h1>
                <p className="lede">
                  <span className="tag">{session.model}</span>
                  <span className="tag">
                    {turns.length} turn{turns.length === 1 ? '' : 's'}
                  </span>
                  {toolCalls.length > 0 && (
                    <span className="tag">
                      {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {session.status !== 'ended' && <span className="tag failed">{session.status}</span>}
                </p>
              </div>
            </div>

            {session.error && <p className="import-note error">{session.error}</p>}

            {turns.length === 0 ? (
              <p className="meta">Nothing was transcribed for this session.</p>
            ) : (
              <div className="panel transcript">
                {turns.map((turn) => (
                  <p key={turn.seq} className={`turn ${turn.role}`}>
                    {turn.text}
                  </p>
                ))}
              </div>
            )}

            {toolCalls.length > 0 && (
              <details className="panel coach-brief">
                <summary>What the coach did</summary>
                <div className="live-activity">
                  {toolCalls.map((call) => (
                    <span key={`${call.seq}-${call.callId}`} className={`tool-chip${call.ok ? '' : ' failed'}`}>
                      {call.name}
                    </span>
                  ))}
                </div>
              </details>
            )}

            <details className="panel coach-brief">
              <summary>The brief this session ran with</summary>
              <pre className="coach-brief-text">{transcript.instructions}</pre>
            </details>
          </div>
        </div>
      </div>
    </>
  )
}
