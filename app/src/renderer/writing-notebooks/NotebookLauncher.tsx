import { useEffect, useMemo, useState } from 'react'
import type { NotebookAssociation, WritingNotebookHit } from '@core/writing-notebooks/types'
import { screenOf, type Route } from '../routes'
import FloatingSurface from '../components/FloatingSurface'
import TitleDialog from './TitleDialog'
export const FLOATING_NOTEBOOK_BUTTON_CHANGED = 'opencourse:floating-notebook-button-changed'
export function NotebookIcon() { return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="3"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5"/></svg> }
export function notebookRouteAssociation(route: Route): NotebookAssociation | undefined {
  const screen = screenOf(route)
  if (screen.name === 'review') return { kind: 'course', id: screen.session.courseId, title: '' }
  if ('courseId' in screen && !['catalogCourse', 'publication'].includes(screen.name)) return { kind: 'course', id: screen.courseId, title: '' }
  if ('documentId' in screen && !['catalogDocument', 'documentPublication'].includes(screen.name)) return { kind: 'document', id: screen.documentId, title: '' }
  return undefined
}
/** Shown until Settings turns it off. A failed read keeps the button, which is the default. */
export function FloatingNotebooks({ route, userId }: { route: Route; userId: string }) {
  const [shown, setShown] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = () => { void window.opencourse.getFloatingNotebookButton().then(value => { if (alive) setShown(value) }).catch(() => { if (alive) setShown(true) }) }
    refresh()
    window.addEventListener(FLOATING_NOTEBOOK_BUTTON_CHANGED, refresh)
    return () => { alive = false; window.removeEventListener(FLOATING_NOTEBOOK_BUTTON_CHANGED, refresh) }
  }, [userId])
  if (shown !== true) return null
  return <NotebookLauncher route={route} userId={userId} />
}
export default function NotebookLauncher({ route, userId }: { route: Route; userId: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [hits, setHits] = useState<WritingNotebookHit[]>([])
  const [association, setAssociation] = useState<NotebookAssociation>(), [creating, setCreating] = useState<{ association?: NotebookAssociation } | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [version, setVersion] = useState(0)
  const target = notebookRouteAssociation(route), key = `${target?.kind}:${target?.id}`
  useEffect(() => { let alive = true; setAssociation(undefined); if (target) void window.opencourse.writing.association(target).then(value => { if (alive) setAssociation(value) }).catch(() => {}); return () => { alive = false } }, [key, userId])
  useEffect(() => window.opencourse.writing.onChanged(() => setVersion(v => v + 1)), [])
  useEffect(() => {
    if (!open) return
    let alive = true; setLoading(true)
    const timer = setTimeout(() => { void window.opencourse.writing.search(query, association).then(value => { if (alive) { setHits(value); setError('') } }).catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) }) }, query ? 150 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, association, open, version])
  const associated = useMemo(() => hits.filter(h => association && h.notebook.association?.kind === association.kind && h.notebook.association.id === association.id), [hits, association])
  const recent = hits.slice(0, 5).filter(h => !associated.some(a => a.notebook.id === h.notebook.id))
  const launch = (hit: WritingNotebookHit) => { void window.opencourse.writing.open(hit.notebook.id, query.trim() ? hit.pageId : undefined).then(() => setOpen(false)).catch(e => setError(e.message)) }
  const row = (hit: WritingNotebookHit) => <button className="writing-launcher-row" key={hit.notebook.id} onClick={() => launch(hit)}><strong>{hit.notebook.title}</strong>{query.trim() && hit.pageTitle && <span>{hit.pageTitle}{hit.excerpt ? ` · ${hit.excerpt}` : ''}</span>}{hit.notebook.association && <small>{hit.notebook.association.title}{hit.notebook.associationAvailable === false ? ' · Unavailable' : ''}</small>}</button>
  return <>
    <FloatingSurface name="notebook" label="Notebooks" open={open} onOpenChange={setOpen} icon={<NotebookIcon />}>
        {association && <button className="writing-create" title={`New notebook for ${association.title}`} onClick={() => { setOpen(false); setCreating({ association }) }}>＋ New notebook for {association.title}</button>}
        <button className="writing-create" onClick={() => { setOpen(false); setCreating({}) }}>＋ New notebook</button>
        <input type="search" aria-label="Search notebooks" placeholder="Search all notebooks…" value={query} maxLength={300} onChange={event => setQuery(event.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}{loading && <p className="meta">Searching…</p>}
        <div className="writing-launcher-results">{query.trim() ? hits.map(row) : <>{associated.length > 0 && <><h3>For {association?.title}</h3><div className="writing-associated">{associated.map(row)}</div></>}<h3>Recent</h3>{recent.map(row)}</>}{!loading && !hits.length && <p className="meta">{query.trim() ? 'No notebooks found.' : 'Your notebooks will appear here.'}</p>}</div>
    </FloatingSurface>
    {creating && <TitleDialog heading="New notebook" submitLabel="Create" detail={creating.association ? `Associated with ${creating.association.title}` : undefined} onClose={() => setCreating(null)} onSubmit={async title => { const notebook = await window.opencourse.writing.create(title, creating.association); await window.opencourse.writing.open(notebook.id) }} />}
  </>
}
