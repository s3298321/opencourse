import { useEffect, useState } from 'react'
import type { CoachProjectSummary } from '@core/types'
import ActionButton from '../components/ActionButton'
import FloatingSurface from '../components/FloatingSurface'
import TitleDialog from '../writing-notebooks/TitleDialog'
import { screenOf, type Route } from '../routes'
import { useCoachConversation } from './useCoachConversation'
import CoachConversation from './CoachConversation'
import DeleteCoachDialog from './DeleteCoachDialog'

export const FLOATING_COACH_BUTTON_CHANGED = 'opencourse:floating-coach-button-changed'
function CoachIcon() { return <svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 17.5 3 21v-6a9 9 0 1 1 4 5"/><path d="M8 10v4m4-7v10m4-7v4" strokeLinecap="round"/></svg> }

export default function CoachLauncher({ route, userId, navigate }: { route: Route; userId: string; navigate: (route: Route) => void }) {
  const [shown, setShown] = useState<boolean | null>(null), [open, setOpen] = useState(false)
  const [coaches, setCoaches] = useState<CoachProjectSummary[]>([]), [query, setQuery] = useState(''), [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState<boolean>(false)
  const [renaming, setRenaming] = useState<CoachProjectSummary | null>(null), [managing, setManaging] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CoachProjectSummary | null>(null)
  const conversation = useCoachConversation(), { stop } = conversation
  useEffect(() => {
    let alive = true
    const refresh = () => { void window.opencourse.getFloatingCoachButton().then(value => { if (alive) setShown(value) }).catch(() => { if (alive) setShown(true) }) }
    refresh(); window.addEventListener(FLOATING_COACH_BUTTON_CHANGED, refresh)
    return () => { alive = false; window.removeEventListener(FLOATING_COACH_BUTTON_CHANGED, refresh) }
  }, [userId])
  useEffect(() => { if (shown === false) { setCreating(false); setRenaming(null); setDeleting(null); void stop() } }, [shown, stop])
  useEffect(() => {
    if (!open) return
    let alive = true
    const refresh = () => { setLoading(true); void window.opencourse.listCoachProjects().then(value => { if (alive) { setCoaches(value); setError('') } }).catch(cause => { if (alive) setError(cause.message) }).finally(() => { if (alive) setLoading(false) }) }
    refresh()
    const unsubscribe = window.opencourse.onCoachChanged(refresh)
    return () => { alive = false; unsubscribe() }
  }, [open])
  if (shown === null || (shown === false && !conversation.coach)) return null
  const hits = coaches.filter(coach => coach.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const settings = () => navigate({ name: 'settings', from: screenOf(route), section: 'connections' })
  const row = (coach: CoachProjectSummary) => <div className="coach-launcher-entry" key={coach.id}>
    <div className="coach-launcher-row"><button className="writing-launcher-row" disabled={coach.busy} onClick={() => { setManaging(null); void conversation.start(coach) }}><strong>{coach.name}</strong>{coach.busy && <small>Conversation in progress</small>}</button><button className="writing-launcher-close" aria-label={`Manage ${coach.name}`} disabled={coach.busy} aria-expanded={managing === coach.id} onClick={() => { setManaging(managing === coach.id ? null : coach.id); setDeleting(null) }}>⋯</button></div>
    <div className="coach-launcher-menu" inert={managing !== coach.id}>
      <div className="coach-launcher-manage">
        <ActionButton icon="edit" className="ghost" onClick={() => setRenaming(coach)}>Rename</ActionButton>
        <ActionButton icon="trash" className="ghost" onClick={() => setDeleting(coach)}>Delete</ActionButton>
      </div>
    </div>
  </div>
  return <>
    <FloatingSurface name="coach" label="Coaches" open={open} onOpenChange={setOpen} icon={<CoachIcon />} active={conversation.busy}
      activityLevel={conversation.view?.status.kind === 'live' && conversation.view.speaking && !conversation.stopping ? Math.sqrt(Math.max(0, (conversation.view.outputLevel ?? 0) - .008) / .12) : 0}>
      {conversation.coach ? <CoachConversation conversation={conversation} openSettings={settings} /> : <>
        <button className="writing-create" onClick={() => setCreating(true)}>＋ New coach</button>
        <input type="search" aria-label="Search coaches" placeholder="Search coaches…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        {conversation.notice && <p className="meta" role="status">{conversation.notice}</p>}
        {loading && <p className="meta">Loading…</p>}
        <div className="writing-launcher-results"><h3>Your coaches</h3>{hits.map(row)}{!loading && !hits.length && <p className="meta">{query ? 'No coaches found.' : 'Create a coach to start talking.'}</p>}</div>
      </>}
    </FloatingSurface>
    {creating && <TitleDialog heading="New coach" placeholder="Coach name" submitLabel="Create" maxLength={60} onClose={() => { setCreating(false); setOpen(true) }} onSubmit={async name => { const coach = await window.opencourse.createCoachProject({ name }); setOpen(true); void conversation.start(coach) }} />}
    {renaming && <TitleDialog heading="Rename coach" placeholder="Coach name" initial={renaming.name} maxLength={60} onClose={() => { setRenaming(null); setOpen(true) }} onSubmit={async name => { await window.opencourse.updateCoachProject(renaming.id, { name }) }} />}
    {deleting && <DeleteCoachDialog name={deleting.name} onClose={() => { setDeleting(null); setOpen(true) }} onDelete={async () => {
      await window.opencourse.deleteCoachProject(deleting.id)
      setCoaches(current => current.filter(coach => coach.id !== deleting.id)); setManaging(null)
    }} />}
  </>
}
