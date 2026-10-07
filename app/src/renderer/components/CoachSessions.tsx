import type { JSX } from 'react'
import type { CoachSessionSummary } from '@core/types'

/** A session's own title is its opening line - what the learner came in asking. */
function title(session: CoachSessionSummary): string {
  const opener = session.title.trim()
  if (opener) return opener.length > 70 ? `${opener.slice(0, 70)}…` : opener
  return session.turns === 0 ? 'Nothing was said' : 'Untitled session'
}

function when(iso: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function lasted(session: CoachSessionSummary): string {
  if (!session.endedAt) return ''
  const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? ' · under a minute' : ` · ${minutes} min`
}

export default function CoachSessions({
  sessions,
  onOpen,
  onDelete
}: {
  sessions: CoachSessionSummary[] | null
  onOpen: (session: CoachSessionSummary) => void
  onDelete: (session: CoachSessionSummary) => void
}): JSX.Element {
  return (
    <div className="panel coach-sessions">
      <div className="coach-brief-head">
        <h2>Sessions</h2>
        {sessions && sessions.length > 0 && <span className="meta">{sessions.length}</span>}
      </div>

      {sessions === null && <p className="meta">Loading…</p>}
      {sessions?.length === 0 && (
        <p className="meta file-empty">No sessions yet. Start one above and this is where it will be kept.</p>
      )}

      {sessions?.map((session) => (
        <div key={session.id} className={`session-row ${session.status}`}>
          <button className="ghost session-open" onClick={() => onOpen(session)}>
            <span className="session-title">{title(session)}</span>
            <span className="meta">
              {when(session.startedAt)}
              {lasted(session)} · {session.turns} turn{session.turns === 1 ? '' : 's'}
              {session.error ? ` · ${session.error}` : ''}
            </span>
          </button>
          <button className="ghost file-act" title="Delete this transcript" onClick={() => onDelete(session)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
