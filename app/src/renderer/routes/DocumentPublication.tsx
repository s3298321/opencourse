import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PublishedDocument } from '@core/learning/types'
import type { ServerResult, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { ConfirmRequest } from '../components/ConfirmDialog'
import { readers } from '../learning/DocumentCatalog'
import type { Route, Screen } from '../routes'

const INDEX: Record<PublishedDocument['status'], string> = { indexing: 'Building search index', ready: 'Searchable', error: 'Search index failed' }

/**
 * Everything a publisher can do to a published document - Publication for a
 * PDF: see every version, make another one current, delete a version, retry
 * its search index, unpublish it or list it again. A new version is published
 * from the document's own page.
 */
export default function DocumentPublication({ serverId, documentId, user, navigate, route, ask }: {
  serverId: string; documentId: string; user: UserProfile | null; navigate: (r: Route) => void; route: Screen
  ask: (request: ConfirmRequest) => Promise<boolean>
}): JSX.Element {
  const [document, setDocument] = useState<PublishedDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState<string | null>(null)

  const take = (result: ServerResult<PublishedDocument>): void => { if (result.ok) { setDocument(result.value); setError(null) } else setError(result.message) }
  const load = useCallback(() => {
    void window.opencourse.getPublishedDocument(serverId, documentId).then(take)
    void window.opencourse.catalogDocumentsInLibrary(serverId, [documentId]).then((map) => setLocal(map[documentId] ?? null)).catch(() => {})
  }, [serverId, documentId])
  useEffect(load, [load])
  // The index is built after the upload; look again until it settles.
  useEffect(() => {
    if (document?.status !== 'indexing') return undefined
    const timer = window.setTimeout(load, 3000)
    return () => window.clearTimeout(timer)
  }, [document, load])

  const run = async (question: ConfirmRequest | null, work: () => Promise<ServerResult<PublishedDocument>>): Promise<void> => {
    if (question && !(await ask(question))) return
    setBusy(true)
    try { take(await work()) } finally { setBusy(false) }
  }

  const back = local
    ? { label: 'Back', onClick: () => navigate({ name: 'documentOverview', documentId: local }) }
    : { label: 'Back', onClick: () => navigate({ name: 'catalogDocument', serverId, documentId }) }
  const current = document?.version
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={back} />
    <div className="body">
      <div className="content scroll">
        <div className="detail publication">
          <h1>{document ? document.title : 'Publication'}</h1>
          {document && <p className="meta">
            {document.moderated ? 'Removed from the catalog by a moderator. Readers who have it keep their copy; only a moderator can list it again.'
              : document.listed ? `Listed in the catalog at v${document.version}` : 'Not listed: nobody can find or add it. Readers who added it keep reading it.'}
            {` · ${readers(document.downloads)} · highest version published: v${document.maxVersion}`}
          </p>}
          {error && <p className="import-note error" role="alert">{error}</p>}
          {document && <>
            <table className="publication-versions">
              <thead><tr><th>Version</th><th>Published</th><th>Search</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                {document.versions.map((v) => {
                  const status = v.deleted ? 'deleted' : v.version === current ? 'current' : 'available'
                  return (
                    <tr key={v.version} className={status}>
                      <td><strong>v{v.version}</strong>{v.releaseNote && <p className="meta publication-note">{v.releaseNote}</p>}</td>
                      <td>{v.publishedAt.slice(0, 10)}</td>
                      <td>{v.version === current && !v.deleted ? <span className="meta" title={document.error ?? undefined}>{INDEX[document.status]}</span> : <span className="meta">–</span>}</td>
                      <td><span className={`update-badge${status === 'current' ? ' update' : ''}`}>{status === 'current' ? 'Current' : status === 'deleted' ? 'Deleted' : 'Available'}</span></td>
                      <td><div className="publication-actions">
                        {status === 'available' && <ActionButton icon="check" className="secondary" disabled={busy} onClick={() => void run(
                          { title: `Make v${v.version} current?`, detail: `Readers who add or update the document get v${v.version}. Their place in it carries over when the PDF is the same; a changed PDF starts its own progress.`, confirmLabel: 'Make current', cancelLabel: 'Cancel' },
                          () => window.opencourse.setCurrentDocumentVersion(serverId, documentId, v.version))}>Make current</ActionButton>}
                        {v.version === current && document.status === 'error' && <ActionButton icon="refresh" className="secondary" disabled={busy} onClick={() => void run(null, () => window.opencourse.reindexDocumentVersion(serverId, documentId, v.version))}>Retry index</ActionButton>}
                        {status === 'available' && <ActionButton icon="trash" className="secondary danger" disabled={busy} onClick={() => void run(
                          { title: `Delete v${v.version}?`, detail: `Its PDF is deleted from the server, and reading it there stops for everyone. Readers who downloaded it keep their copy. The number v${v.version} can never be published again.`, confirmLabel: 'Delete version', cancelLabel: 'Cancel', danger: true },
                          () => window.opencourse.deleteDocumentVersion(serverId, documentId, v.version))}>Delete</ActionButton>}
                      </div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="actions">
              {document.listed
                ? <ActionButton icon="trash" className="secondary danger" disabled={busy} onClick={() => void run(
                    { title: 'Unpublish this document?', detail: 'It leaves the catalog and nobody new can add it. Readers who added it keep it and their progress. Nothing is deleted; you can list it again.', confirmLabel: 'Unpublish', cancelLabel: 'Cancel', danger: true },
                    () => window.opencourse.unpublishDocument(serverId, documentId))}>Unpublish document</ActionButton>
                : !document.moderated && <ActionButton icon="refresh" disabled={busy || document.versions.every((v) => v.deleted)} onClick={() => void run(null, () => window.opencourse.relistDocument(serverId, documentId))}>List in the catalog again</ActionButton>}
            </div>
          </>}
        </div>
      </div>
    </div>
  </>
}
