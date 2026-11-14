import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { DocumentSummary } from '@core/documents/types'
import { documentProgressPercent } from '@core/documents/progress'
import type { UpdateState } from '@core/catalog/origin'
import type { ServerConnection, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import CourseSourcePanel from '../components/CourseSourcePanel'
import type { Route, Screen } from '../routes'
import { useScreenActive } from '../screen-activity'

/** What a server document's card says about its version on the server, as a course's does. */
function updateLabel(state: UpdateState | undefined): { text: string; tone: 'update' | 'muted' } | null {
  switch (state?.kind) {
    case 'update': return { text: `Update to v${state.version}`, tone: 'update' }
    case 'switch': return { text: `Publisher rolled back to v${state.version}`, tone: 'update' }
    case 'unlisted': return { text: 'No longer published', tone: 'muted' }
    case 'disconnected': return state.reason === 'not-connected' ? { text: 'Server not connected', tone: 'muted' } : null
    default: return null
  }
}

const offersDocuments = (server: ServerConnection): boolean => !server.capabilities || server.capabilities.includes('documents-v1')

export default function Documents({ user, route, navigate, importSignal, onImportHandled }: { user: UserProfile | null; route: Screen; navigate: (route: Route) => void; importSignal: number; onImportHandled: () => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null)
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'incomplete' | 'completed' | null>(null)
  const requestedSource = route.name === 'documents' ? route.source ?? 'local' : 'local'
  const [source, setSource] = useState(requestedSource)
  useEffect(() => setSource(requestedSource), [requestedSource])
  const active = useScreenActive()
  const refresh = useCallback(() => {
    void window.opencourse.listDocuments().then((list) => {
      setDocuments(list)
      // Only server copies have anything to ask a server about.
      if (list.some((d) => d.origin)) void window.opencourse.checkDocumentUpdates().then(setUpdates).catch(() => {})
    }).catch(error => setError(error.message))
  }, [])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onDocumentsChanged(refresh), [refresh])
  const loadServers = useCallback(() => { void window.opencourse.listServers().then(setServers).catch((error) => setError(`Servers could not be loaded. ${error.message}`)) }, [])
  useEffect(loadServers, [loadServers])
  useEffect(() => window.opencourse.onServersChanged(loadServers), [loadServers])

  const importPdf = useCallback(async (file?: File) => {
    setBusy(true); setError(null)
    try {
      const result = file ? await window.opencourse.importDroppedDocument(file) : await window.opencourse.importDocument()
      if (result.status === 'ok') navigate({ name: 'document', documentId: result.document.id })
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false); setDragging(false) }
  }, [navigate])
  useEffect(() => { if (active && importSignal > 0) { onImportHandled(); void importPdf() } }, [importSignal, active, importPdf, onImportHandled])

  // The sources are the Courses page's: local, one per server, and what is left of removed servers.
  const connected = new Set(servers?.map((server) => server.id))
  const local = documents?.filter((d) => !d.origin) ?? []
  const disconnected = documents?.filter((d) => d.origin && !connected.has(d.origin.connectionId)) ?? []
  const sources: { id: string; name: string; documents: DocumentSummary[]; url?: string }[] = [
    { id: 'local', name: 'Local', documents: local },
    ...(servers ?? []).filter((server) => offersDocuments(server) || documents?.some((d) => d.origin?.connectionId === server.id))
      .map((server) => ({ id: server.id, name: server.name, url: server.url, documents: documents?.filter((d) => d.origin?.connectionId === server.id) ?? [] })),
    ...(servers !== null && disconnected.length ? [{ id: 'disconnected', name: 'Disconnected', documents: disconnected }] : [])
  ]
  const selected = sources.find((item) => item.id === source) ?? sources[0]!
  const selectedServer = servers?.find((server) => server.id === selected.id)
  useEffect(() => {
    // A removed connection should never leave the list on a missing tab.
    if (servers !== null && documents !== null && selected.id !== source) setSource(selected.id)
  }, [servers, documents, source, selected.id])
  const visible = selected.documents.filter(document => document.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === null || (filter === 'completed') === (documentProgressPercent(document) === 100)))

  const empty = documents?.length === 0

  return <>
    <TitleBar user={user} navigate={navigate} route={route} />
    <div className="body">
      <main className={`content content-glass scroll documents-library${dragging ? ' documents-drop-active' : ''}`}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => { event.preventDefault(); if (!busy && event.dataTransfer.files[0]) void importPdf(event.dataTransfer.files[0]); setDragging(false) }}>
        <div className="library">
          <div className="library-head"><div><h1>Documents</h1></div><ActionButton icon="upload" disabled={busy} onClick={() => void importPdf()}>{busy ? 'Importing…' : 'Import PDF'}</ActionButton></div>
          <div className="course-source-bar">
            <div className="course-source-tabs" role="tablist" aria-label="Document source">
              {sources.map((item, index) => (
                <button key={item.id} id={`document-source-${index}`} role="tab" aria-selected={selected.id === item.id}
                  aria-controls="document-source-panel" tabIndex={selected.id === item.id ? 0 : -1}
                  title={item.url} onClick={() => setSource(item.id)}
                  onKeyDown={(event) => {
                    let next: number
                    switch (event.key) {
                      case 'ArrowRight': next = (index + 1) % sources.length; break
                      case 'ArrowLeft': next = (index - 1 + sources.length) % sources.length; break
                      case 'Home': next = 0; break
                      case 'End': next = sources.length - 1; break
                      default: return
                    }
                    event.preventDefault()
                    setSource(sources[next]!.id)
                    document.getElementById(`document-source-${next}`)?.focus()
                  }}>
                  {item.name}<span className="course-source-count" aria-label={`${item.documents.length} ${item.documents.length === 1 ? 'document' : 'documents'}`}>{item.documents.length}</span>
                </button>
              ))}
            </div>
          </div>
          <CourseSourcePanel source={selected.id} index={sources.indexOf(selected)} prefix="document-source">
          {error && <p className="import-note error" role="alert">{error}</p>}
          {selected.documents.length > 0 && <div className="documents-search">
            <input type="search" aria-label="Find a document" placeholder="Find a document…" value={query} onChange={event => setQuery(event.target.value)} />
          </div>}
          <div className="documents-library-list">
            {selectedServer && offersDocuments(selectedServer) && <button className="add-courses" aria-label="Add documents" onClick={() => navigate({ name: 'documentCatalog', serverId: selectedServer.id })}>
              <span className="add-courses-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg></span>
              <span className="add-courses-label" aria-hidden="true">Add documents</span>
            </button>}
            <div className="course-status-filters" role="group" aria-label="Filter documents by status">
              {(['incomplete', 'completed'] as const).map(value => {
                const label = value === 'incomplete' ? 'To read' : 'Completed'
                return <button key={value} className="course-status-filter" aria-label={label} aria-pressed={filter === value}
                  title={filter === value ? `${label} · Click to show all documents` : label}
                  disabled={documents === null} onClick={() => setFilter(filter === value ? null : value)}>
                  <span className={`course-status-circle ${value === 'incomplete' ? 'not-started' : 'completed'}`} aria-hidden="true">
                    {value === 'completed' && <svg viewBox="0 0 16 16"><path d="m4 8 3 3 5-6" /></svg>}
                  </span>
                </button>
              })}
            </div>
            <div>
          {documents === null ? <p className="meta">Loading documents…</p>
            : empty && selected.id === 'local' ? <div className="empty-library document-empty"><span className="document-glyph" aria-hidden="true">▤</span><h3>Bring something to read</h3><p>Import a PDF or drop one here, or select a server and choose Add documents.</p></div>
            : selected.documents.length === 0 ? <div className="empty-library document-empty"><span className="document-glyph" aria-hidden="true">▤</span>
              <h3>{selected.id === 'local' ? 'No local documents yet' : `No documents from ${selected.name} yet`}</h3>
              <p>{selected.id === 'local' ? 'Import a PDF or drop one here.' : 'Add a document from this server’s catalog to see it here.'}</p></div>
            : visible.length === 0 ? <p className="meta">No documents match this filter.</p>
            : <div className="documents-cards">{visible.map(document => {
              const label = updateLabel(updates[document.id])
              return <article className="document-card" key={document.id}>
                <button className="document-card-open" onClick={() => navigate({ name: 'documentOverview', documentId: document.id })}><span className="document-glyph" aria-hidden="true">▤</span><div>
                  <h3>{document.title}</h3>
                  <div className="course-card-origin">
                    <span className={`origin-badge${document.origin ? ' from-server' : ''}`}>{document.origin ? document.origin.name : 'Local'}</span>
                    {document.origin && <span className="version-badge">v{document.origin.version}</span>}
                    {!document.origin && document.publishedTo?.length ? <span className="meta">Published</span> : null}
                    {label && <span className={`update-badge ${label.tone}`}>{label.text}</span>}
                  </div>
                  <div className="meta">{document.pages ? `${document.pages} pages · ` : ''}{(document.bytes / 1024 / 1024).toFixed(1)} MB</div>
                  <div className="meta">{documentProgressPercent(document)}% read{document.status === 'indexing' ? ' · Building search index…' : document.status === 'error' ? ' · Text index unavailable' : document.searchablePages === 0 ? ' · Image-only PDF' : ''}</div>
                </div></button>
              </article>
            })}</div>}
            </div>
          </div>
          </CourseSourcePanel>
        </div>
      </main>
    </div>
  </>
}
