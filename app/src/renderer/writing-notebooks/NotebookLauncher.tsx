import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NotebookAssociation, WritingNotebookHit } from '@core/writing-notebooks/types'
import { screenOf, type Route } from '../routes'
import TitleDialog from './TitleDialog'
export function NotebookIcon() { return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="3"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5"/></svg> }
export function notebookRouteAssociation(route: Route): NotebookAssociation | undefined {
  const screen = screenOf(route)
  if (screen.name === 'review') return { kind: 'course', id: screen.session.courseId, title: '' }
  if ('courseId' in screen && !['catalogCourse', 'publication'].includes(screen.name)) return { kind: 'course', id: screen.courseId, title: '' }
  if ('documentId' in screen && !['catalogDocument', 'documentPublication'].includes(screen.name)) return { kind: 'document', id: screen.documentId, title: '' }
  if ('projectId' in screen) return { kind: 'coach', id: screen.projectId, title: '' }
  return undefined
}
export default function NotebookLauncher({ route, userId }: { route: Route; userId: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [hits, setHits] = useState<WritingNotebookHit[]>([])
  const [association, setAssociation] = useState<NotebookAssociation>(), [creating, setCreating] = useState<{ association?: NotebookAssociation } | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [version, setVersion] = useState(0)
  const [panelHeight, setPanelHeight] = useState(56)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Keep the content mounted so the same surface can shrink back into the button.
  useLayoutEffect(() => {
    const element = panel.current!
    const measure = () => setPanelHeight(element.getBoundingClientRect().height + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const target = notebookRouteAssociation(route), key = `${target?.kind}:${target?.id}`
  useEffect(() => { let alive = true; setAssociation(undefined); if (target) void window.opencourse.writing.association(target).then(value => { if (alive) setAssociation(value) }).catch(() => {}); return () => { alive = false } }, [key, userId])
  useEffect(() => window.opencourse.writing.onChanged(() => setVersion(v => v + 1)), [])
  useEffect(() => {
    if (!open) return
    let alive = true; setLoading(true)
    const timer = setTimeout(() => { void window.opencourse.writing.search(query, association).then(value => { if (alive) { setHits(value); setError('') } }).catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) }) }, query ? 150 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, association, open, version])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const associated = useMemo(() => hits.filter(h => association && h.notebook.association?.kind === association.kind && h.notebook.association.id === association.id), [hits, association])
  const recent = hits.slice(0, 5).filter(h => !associated.some(a => a.notebook.id === h.notebook.id))
  const launch = (hit: WritingNotebookHit) => { void window.opencourse.writing.open(hit.notebook.id, query.trim() ? hit.pageId : undefined).then(() => setOpen(false)).catch(e => setError(e.message)) }
  const row = (hit: WritingNotebookHit) => <button className="writing-launcher-row" key={hit.notebook.id} onClick={() => launch(hit)}><strong>{hit.notebook.title}</strong>{query.trim() && hit.pageTitle && <span>{hit.pageTitle}{hit.excerpt ? ` · ${hit.excerpt}` : ''}</span>}{hit.notebook.association && <small>{hit.notebook.association.title}{hit.notebook.associationAvailable === false ? ' · Unavailable' : ''}</small>}</button>
  return <>
    <div ref={root} className={`writing-launcher${open ? ' expanded' : ''}`} style={{ height: open ? panelHeight : 56 }} onKeyDown={event => {
      if (!open) return
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('.writing-launcher-panel button')]; const current = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1); if (buttons[next]) { event.preventDefault(); buttons[next]!.focus() } }
    }}>
      <div ref={panel} className="writing-launcher-panel" role="region" aria-label="Notebooks" inert={!open} aria-hidden={!open}>
        <header><strong>Notebooks</strong><button className="writing-launcher-close" aria-label="Close notebooks" onClick={() => { setOpen(false); trigger.current?.focus() }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
        {association && <button className="writing-create" title={`New notebook for ${association.title}`} onClick={() => { setOpen(false); setCreating({ association }) }}>＋ New notebook for {association.title}</button>}
        <button className="writing-create" onClick={() => { setOpen(false); setCreating({}) }}>＋ New notebook</button>
        <input ref={search} type="search" aria-label="Search notebooks" placeholder="Search all notebooks…" value={query} maxLength={300} onChange={event => setQuery(event.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}{loading && <p className="meta">Searching…</p>}
        <div className="writing-launcher-results">{query.trim() ? hits.map(row) : <>{associated.length > 0 && <><h3>For {association?.title}</h3><div className="writing-associated">{associated.map(row)}</div></>}<h3>Recent</h3>{recent.map(row)}</>}{!loading && !hits.length && <p className="meta">{query.trim() ? 'No notebooks found.' : 'Your notebooks will appear here.'}</p>}</div>
      </div>
      <button ref={trigger} className="writing-launcher-toggle" title="Notebooks" aria-label="Notebooks" aria-expanded={open} aria-hidden={open} tabIndex={open ? -1 : 0} onClick={() => setOpen(value => !value)}><NotebookIcon /></button>
    </div>
    {creating && <TitleDialog heading="New notebook" submitLabel="Create" detail={creating.association ? `Associated with ${creating.association.title}` : undefined} onClose={() => { setCreating(null); trigger.current?.focus() }} onSubmit={async title => { const notebook = await window.opencourse.writing.create(title, creating.association); await window.opencourse.writing.open(notebook.id) }} />}
  </>
}
