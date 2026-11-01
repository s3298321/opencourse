import { useEffect, useRef, useState } from 'react'
import { atBottom } from '@core/coach/scroll'
import { MAX_SESSION_MS } from './live'
import type { useCoachConversation } from './useCoachConversation'

export default function CoachConversation({ conversation, openSettings }: {
  conversation: ReturnType<typeof useCoachConversation>; openSettings: () => void
}) {
  const { coach, view, starting, stopping, error, busy, start, stop } = conversation
  const transcript = useRef<HTMLDivElement>(null), [following, setFollowing] = useState(true)
  useEffect(() => { if (following && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight }, [view, following])
  if (!coach) return null
  const status = stopping ? 'Saving what we worked on…' : starting ? 'Connecting…' : error ? 'Could not connect' : !view ? 'Ready to connect' :
    view.status.kind === 'live' ? view.speaking ? 'Coach is speaking' : view.responding ? 'Coach is thinking…' : 'Listening' :
    view.status.kind === 'wrapping-up' ? view.status.note : view.status.kind === 'error' ? view.status.message :
    view.status.kind === 'lost' ? 'Connection lost' : view.status.kind === 'mic-denied' ? 'Microphone unavailable' : 'Connecting…'
  const saving = stopping || view?.status.kind === 'wrapping-up'
  const runningTools = view?.activity.filter(entry => entry.state === 'running') ?? []
  const seconds = Math.floor((view?.elapsedMs ?? 0) / 1000)
  const failed = !!error || ['error', 'lost', 'mic-denied'].includes(view?.status.kind ?? '')
  return <div className="coach-conversation">
    <div className="coach-conversation-heading"><strong>{coach.name}</strong></div>
    <div className="coach-conversation-status" role="status"><span className={busy ? 'live-dot' : ''} />{status}{view && <time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {view?.warning && !failed && <p className="error" role="alert">{view.warning}</p>}
    {failed && <button className="ghost" onClick={openSettings}>Open settings</button>}
    {(view || starting) && <meter style={{ visibility: view?.status.kind === 'live' ? 'visible' : 'hidden' }} className="coach-microphone-level" aria-label="Microphone level" min={0} max={.1} value={view?.inputLevel ?? 0} />}
    {(view || starting) && <div className="coach-conversation-dialog"><div className="coach-conversation-transcript" ref={transcript} tabIndex={0} aria-label="Current conversation" onScroll={() => { if (transcript.current) setFollowing(atBottom(transcript.current)) }}>
      {!view?.turns.length && <p className="meta">{starting ? 'Connecting to your coach…' : 'Your conversation will appear here.'}</p>}
      {view?.turns.map(turn => <p key={turn.seq} className={`turn ${turn.role}`}><small>{turn.role === 'user' ? 'You' : coach.name}</small>{turn.text.trimStart()}</p>)}
      {view?.partial && <p className={`turn ${view.partial.role} partial`}>{view.partial.text.trimStart()}</p>}
      {(view?.elapsedMs ?? 0) > MAX_SESSION_MS * .9 && <p className="meta">This conversation will finish soon at the 45-minute limit.</p>}
    </div>
    {!following && <button className="ghost coach-conversation-latest" onClick={() => setFollowing(true)}>↓ Latest</button>}</div>}
    <footer>
      {!busy && <button className="action-button" onClick={() => void start(coach)}>Try again</button>}
      <button className="action-button secondary" disabled={saving} onClick={() => void stop()}>{busy ? 'End conversation' : 'Back to coaches'}</button>
      {runningTools.length > 0 && <span className="coach-current-tools" role="status" aria-label="Running coach tools" title={runningTools.map(entry => entry.text).join(' · ')}>
        <span className="coach-current-tool-label">{runningTools[0]!.text}</span>
        {runningTools.length > 1 && <span className="coach-current-tool-count">+{runningTools.length - 1}</span>}
      </span>}
    </footer>
  </div>
}
