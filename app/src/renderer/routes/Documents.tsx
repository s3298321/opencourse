import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { DocumentSummary } from '@core/documents/types'
import type { UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'
import { useScreenActive } from '../screen-activity'

export default function Documents({ user, route, navigate, importSignal, onImportHandled }: { user: UserProfile | null; route: Screen; navigate: (route: Route) => void; importSignal: number; onImportHandled: () => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'incomplete' | 'completed' | null>(null)
  const active = useScreenActive()
  const refresh = useCallback(() => { void window.opencourse.listDocuments().then(setDocuments).catch(error => setError(error.message)) }, [])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onDocumentsChanged(refresh), [refresh])
  const importPdf = useCallback(async (file?: File) => {
    setBusy(true); setError(null)
    try {
      const result = file ? await window.opencourse.importDroppedDocument(file) : await window.opencourse.importDocument()
      if (result.status === 'ok') navigate({ name: 'document', documentId: result.document.id })
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false); setDragging(false) }
  }, [navigate])
  useEffect(() => { if (active && importSignal > 0) { onImportHandled(); void importPdf() } }, [importSignal, active, importPdf, onImportHandled])
  const visible = documents?.filter(document => document.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === null || (filter === 'completed') === document.completed))
  const remove = async (document: DocumentSummary): Promise<void> => {
    if (!window.confirm(`Remove “${document.title}” and its chats from this library? The original PDF is kept.`)) return
    try { await window.opencourse.removeDocument(document.id) } catch (error) { setError((error as Error).message) }
  }
  return <>
    <TitleBar user={user} navigate={navigate} route={route} />
    <div className="body">
      <main className={`content content-glass scroll documents-library${dragging ? ' documents-drop-active' : ''}`}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => { event.preventDefault(); if (!busy && event.dataTransfer.files[0]) void importPdf(event.dataTransfer.files[0]); setDragging(false) }}>
        <div className="library">
          <div className="library-head"><div><h1>Documents</h1></div><ActionButton icon="upload" disabled={busy} onClick={() => void importPdf()}>{busy ? 'Importing…' : 'Import PDF'}</ActionButton></div>
          {error && <p className="import-note error" role="alert">{error}</p>}
          <div className="documents-search">
            <input type="search" aria-label="Find a document" placeholder="Find a document…" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <div className="documents-library-list">
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
          {documents === null ? <p className="meta">Loading documents…</p> : documents.length === 0 ? <div className="empty-library document-empty"><span className="document-glyph" aria-hidden="true">▤</span><h3>Bring something to read</h3><p>Import a PDF or drop one here.</p></div> : visible?.length === 0 ? <p className="meta">No documents match this filter.</p> : <div className="documents-cards">{visible?.map(document => <article className="document-card" key={document.id}>
            <button className="document-card-open" onClick={() => navigate({ name: 'document', documentId: document.id })}><span className="document-glyph" aria-hidden="true">▤</span><div><h3>{document.title}</h3><div className="meta">{document.pages ? `${document.pages} pages · ` : ''}{(document.bytes / 1024 / 1024).toFixed(1)} MB</div><div className="meta">{document.completed ? 'Completed' : 'To read'}{document.status === 'indexing' ? ' · Building search index…' : document.status === 'error' ? ' · Text index unavailable' : document.searchablePages === 0 ? ' · Image-only PDF' : ''}</div></div></button>
            <div className="document-card-actions"><button className="ghost" onClick={() => void window.opencourse.setDocumentCompleted(document.id, !document.completed).catch(error => setError(error.message))}>{document.completed ? 'Mark incomplete' : 'Mark completed'}</button><button className="ghost" onClick={() => void remove(document)}>Remove</button></div>
          </article>)}</div>}
            </div>
          </div>
        </div>
      </main>
    </div>
  </>
}
