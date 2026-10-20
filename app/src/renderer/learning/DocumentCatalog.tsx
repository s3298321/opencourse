import ActionButton from '../components/ActionButton'
import ServerUnreachable, { serverDown } from '../components/ServerUnreachable'
import CourseCardMedia from '../components/CourseCardMedia'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CatalogSort, CatalogTag } from '@core/catalog/api'
import type { PublishedDocument } from '@core/learning/types'
import type { ServerConnection } from '@core/types'
import type { Route, Screen } from '../routes'

type Page = { documents: PublishedDocument[]; total: number; page: number; pageSize: number }

export const documentSize = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
export const readers = (n: number): string => n === 1 ? '1 reader' : `${n} readers`

/**
 * Documents → Add documents: the selected server's documents, the way
 * Catalog is its courses. Everything comes through main, covers included -
 * the renderer still makes no network request of its own.
 */
export function DocumentCatalog({ server: active, loadingServer, navigate, route }: {
  server: ServerConnection | null
  loadingServer: boolean
  navigate: (r: Route) => void
  route: Screen
}): JSX.Element {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [sort, setSort] = useState<CatalogSort | ''>('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Page | null>(null)
  const [allTags, setAllTags] = useState<CatalogTag[]>([])
  const [inLibrary, setInLibrary] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  // Down, the search is asked again when it comes back (and once on the way down).
  const down = serverDown(active)

  // Typing settles before it searches; a new search starts at page one.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(q); setPage(1) }, 250)
    return () => clearTimeout(timer)
  }, [q])

  useEffect(() => {
    if (!active) return undefined
    let alive = true
    setError(null)
    setResult(null)
    void window.opencourse.searchDocumentCatalog(active.id, { q: query, tags, sort: sort || undefined, page }).then((r) => {
      if (!alive) return
      if (r.ok) setResult(r.value)
      else { setResult(null); setError(r.message) }
    }).catch((err) => { if (alive) { setResult(null); setError(err.message) } })
    return () => { alive = false }
  }, [active?.id, query, tags, sort, page, down])

  useEffect(() => {
    if (!active || !result) return undefined
    let alive = true
    const load = () => { void window.opencourse.catalogDocumentsInLibrary(active.id, result.documents.map((d) => d.id)).then((map) => { if (alive) setInLibrary(map) }).catch(() => {}) }
    load()
    const off = window.opencourse.onDocumentsChanged(load)
    return () => { alive = false; off() }
  }, [active?.id, result])

  useEffect(() => {
    if (!active) return
    let alive = true
    void window.opencourse.listDocumentCatalogTags(active.id).then((r) => { if (alive) setAllTags(r.ok ? r.value : []) }).catch(() => { if (alive) setAllTags([]) })
    return () => { alive = false }
  }, [active?.id, result?.total])

  if (loadingServer) return <p className="meta">Loading…</p>
  if (!active) {
    return (
      <div className="empty-library catalog-empty">
        <h3>No server to browse</h3>
        <p>Connect to a server in Settings.</p>
        <ActionButton icon="settings" onClick={() => navigate({ name: 'settings', from: route, section: 'servers' })}>Open Settings</ActionButton>
      </div>
    )
  }

  const add = async (document: PublishedDocument): Promise<void> => {
    setAdding(document.id); setNote(null)
    try {
      const r = await window.opencourse.addCatalogDocument(active.id, document.id)
      if (r.ok) { setInLibrary((now) => ({ ...now, [document.id]: r.value.documentId })); setNote({ text: `Added “${r.value.title}” (v${r.value.version}) to your documents.`, error: false }) }
      else setNote({ text: r.message, error: true })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally { setAdding(null) }
  }
  const toggleTag = (tag: string): void => { setTags((now) => now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]); setPage(1) }
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1

  return (
    <div className="catalog">
      <div className="catalog-bar">
        <input type="search" className="catalog-search" aria-label="Search documents" placeholder="Search by keyword" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Sort documents" value={sort} onChange={(e) => { setSort(e.target.value as CatalogSort | ''); setPage(1) }}>
          <option value="">Newest</option>
          <option value="downloads">Most read</option>
          <option value="recent">Recently updated</option>
          <option value="title">Title</option>
        </select>
      </div>
      {!active.account && !down && (
        <p className="import-note">You are signed out of {active.name}. <button className="ghost catalog-inline" onClick={() => navigate({ name: 'settings', from: route, section: 'servers' })}>Sign in</button> to add documents.</p>
      )}
      {allTags.length > 0 && (
        <div className="catalog-tags" aria-label="Filter by tag">
          {allTags.map((t) => (
            <button key={t.tag} className={`catalog-tag${tags.includes(t.tag) ? ' on' : ''}`} aria-pressed={tags.includes(t.tag)} onClick={() => toggleTag(t.tag)}>
              {t.tag} <span>{t.count}</span>
            </button>
          ))}
        </div>
      )}
      {note && <p className={`import-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
      {down ? <ServerUnreachable server={active} /> : error && <p className="import-note error" role="alert">{error}</p>}
      {!result && !error && !down && <p className="meta">Loading documents…</p>}
      {result && <p className="meta catalog-count">{result.total === 1 ? '1 document' : `${result.total} documents`}{query || tags.length ? ' match' : ` on ${active.name}`}</p>}
      {result?.documents.length === 0 && <p className="meta">{query || tags.length ? 'Nothing matches. Try fewer words or tags.' : 'Nothing has been published here yet.'}</p>}
      <div className="catalog-grid">
        {result?.documents.map((document) => (
          <DocumentCard key={document.id} serverId={active.id} document={document} local={inLibrary[document.id] ?? null} adding={adding === document.id} canAdd={Boolean(active.account) && !down}
            onOpen={() => navigate({ name: 'catalogDocument', serverId: active.id, documentId: document.id })}
            onAdd={() => void add(document)} />
        ))}
      </div>
      {pages > 1 && (
        <nav className="catalog-pager">
          <ActionButton icon="left" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</ActionButton>
          <span className="meta">Page {page} of {pages}</span>
          <ActionButton icon="right" className="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</ActionButton>
        </nav>
      )}
    </div>
  )
}

/** A version's cover never changes, so main keeps it for the launch. */
export function useDocumentCover(serverId: string, document: { id: string; version: string; hasCover: boolean }): string | null {
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    if (!document.hasCover) { setCover(null); return undefined }
    let alive = true
    void window.opencourse.getDocumentCatalogCover(serverId, document.id, document.version).then((url) => { if (alive) setCover(url) }).catch(() => {})
    return () => { alive = false }
  }, [serverId, document.id, document.version, document.hasCover])
  return cover
}

function DocumentCard({ serverId, document, local, adding, canAdd, onOpen, onAdd }: {
  serverId: string; document: PublishedDocument; local: string | null; adding: boolean; canAdd: boolean
  onOpen: () => void; onAdd: () => void
}): JSX.Element {
  const cover = useDocumentCover(serverId, document)
  return (
    <div className="course-card catalog-card document-catalog-card" onClick={onOpen}>
      <CourseCardMedia coverUrl={cover ?? undefined} tags={document.tags} />
      <div className="course-card-content">
        <h3 title={document.title}>{document.title}</h3>
        <div className="meta course-card-meta">PDF · {document.pages === 1 ? '1 page' : `${document.pages} pages`} · {documentSize(document.bytes)}</div>
        <div className="course-card-origin">
          <span className="version-badge">v{document.version}</span>
          <span className="meta">{readers(document.downloads)} · by {document.publisher}</span>
        </div>
        {document.description && <p className="catalog-summary">{document.description.replace(/[#*_`>[\]()]/g, '').slice(0, 220)}</p>}
      </div>
      <div className="catalog-card-action" onClick={(e) => { if (!local) e.stopPropagation() }}>
        {local
          ? <span className="catalog-library-status">In your documents</span>
          : <ActionButton icon="plus" disabled={adding || !canAdd} onClick={onAdd}>{adding ? 'Adding' : 'Add'}</ActionButton>}
      </div>
    </div>
  )
}
