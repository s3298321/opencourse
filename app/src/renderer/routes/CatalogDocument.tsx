import ActionButton from '../components/ActionButton'
import ServerUnreachable, { downTitle, serverDown, useServerConnection } from '../components/ServerUnreachable'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PublishedDocument } from '@core/learning/types'
import type { UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import CourseDescription from '../components/CourseDescription'
import { documentSize, readers, useDocumentCover } from '../learning/DocumentCatalog'
import type { Route, Screen } from '../routes'

/**
 * A server document before it is added: what it is, how long, who published
 * it, its outline and its versions - CatalogCourse for a PDF.
 */
export default function CatalogDocument({ serverId, documentId, user, navigate, route }: {
  serverId: string; documentId: string; user: UserProfile | null; navigate: (r: Route) => void; route: Screen
}): JSX.Element {
  const [document, setDocument] = useState<PublishedDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void window.opencourse.getCatalogDocument(serverId, documentId).then((r) => { if (r.ok) setDocument(r.value); else setError(r.message) })
    void window.opencourse.catalogDocumentsInLibrary(serverId, [documentId]).then((map) => setLocal(map[documentId] ?? null)).catch(() => {})
  }, [serverId, documentId])
  useEffect(load, [load])
  useEffect(() => window.opencourse.onDocumentsChanged(load), [load])
  const server = useServerConnection(serverId, () => { setError(null); load() })
  const down = serverDown(server)
  const cover = useDocumentCover(serverId, document ?? { id: documentId, version: '0.0.0', hasCover: false })

  const add = async (): Promise<void> => {
    setBusy(true); setNote(null)
    try {
      const r = await window.opencourse.addCatalogDocument(serverId, documentId)
      if (r.ok) { setLocal(r.value.documentId); setNote({ text: `Added to your documents (v${r.value.version}).`, error: false }) }
      else setNote({ text: r.message, error: true })
    } finally { setBusy(false) }
  }

  const back = { label: server?.name ?? 'Documents', onClick: () => navigate({ name: 'documentCatalog', serverId }) }
  if (!document) {
    return <>
      <TitleBar user={user} navigate={navigate} route={route} back={back} />
      <div className="body"><div className="content scroll"><div className="detail">{server && down ? <ServerUnreachable server={server} /> : error ? <p className="import-note error">{error}</p> : <p className="meta">Loading…</p>}</div></div></div>
    </>
  }

  const versions = document.versions.filter((v) => !v.deleted)
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={back} />
    <div className="body">
      <div className="content scroll">
        <div className="detail catalog-detail">
          {cover && <img className="catalog-detail-cover" src={cover} alt="" />}
          <h1>{document.title}</h1>
          <div className="meta">PDF · {document.pages === 1 ? '1 page' : `${document.pages} pages`} · {documentSize(document.bytes)}{document.status === 'indexing' ? ' · Search index being built' : ''}</div>
          <div className="course-card-origin catalog-detail-stats">
            <span className="version-badge">v{document.version}</span>
            <span className="meta">{readers(document.downloads)} · published by {document.publisher}{document.ownedByYou ? ' (you)' : ''}{document.updatedAt ? ` · updated ${document.updatedAt.slice(0, 10)}` : ''}</span>
            {!document.listed && <span className="update-badge muted">Unpublished</span>}
          </div>
          {document.tags.length > 0 && <div className="course-card-tags">{document.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>}

          <div className="actions catalog-detail-actions">
            {local
              ? <ActionButton icon="book" onClick={() => navigate({ name: 'documentOverview', documentId: local })}>Open in my documents</ActionButton>
              : <ActionButton icon="plus" disabled={busy || down} title={server && down ? downTitle(server) : undefined} onClick={() => void add()}>{busy ? 'Adding' : 'Add to my documents'}</ActionButton>}
            {document.ownedByYou && <ActionButton icon="settings" className="secondary" disabled={down} onClick={() => navigate({ name: 'documentPublication', serverId, documentId })}>Manage publication</ActionButton>}
          </div>
          {server && down && <ServerUnreachable server={server} />}
          {note && <p className={`import-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
          {!local && <p className="meta">Your reading progress is kept with your account on {server?.name ?? 'this server'}, so it is the same here and on the server’s website.</p>}

          {document.description && <CourseDescription key={`${serverId}:${documentId}`} source={document.description} />}

          {document.sections.length > 0 && (
            <div className="panel">
              <h2>Contents</h2>
              {document.sections.map((section) => (
                <div className="lesson-row catalog-row document-outline-row" key={section.id} style={{ paddingLeft: `${0.5 + Math.min(section.depth, 4) * 1}rem` }}>
                  <span>{section.title}</span>
                  <span className="mins">p. {section.page}</span>
                </div>
              ))}
            </div>
          )}

          <div className="panel">
            <h2>Versions</h2>
            <ul className="catalog-versions">
              {versions.map((v) => (
                <li key={v.version}>
                  <strong>v{v.version}</strong>
                  {v.version === document.version && <span className="version-badge">Current</span>}
                  <span className="meta">{v.publishedAt.slice(0, 10)}</span>
                  {v.releaseNote && <p className="catalog-release-note">{v.releaseNote}</p>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  </>
}
