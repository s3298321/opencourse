import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DocumentView } from '@core/documents/types'
import { documentProgressPercent } from '@core/documents/progress'
import type { UpdateState } from '@core/catalog/origin'
import type { ServerConnection, UserProfile } from '@core/types'
import type { DocumentPublication } from '../../main/document-publish'
import type { DocumentPublishPreview } from '../../main/document-catalog'
import TitleBar from '../components/TitleBar'
import CourseDescription from '../components/CourseDescription'
import { documentSize } from '../learning/DocumentCatalog'
import type { Route, Screen } from '../routes'

/**
 * A document's page, the way CourseDetail is a course's: what it is, how far
 * you are, its outline, and - through DocumentServerPanel - where it came
 * from, its updates, publishing it and managing what was published.
 */
export default function DocumentOverview({ documentId, user, navigate, route }: {
  documentId: string
  user: UserProfile | null
  navigate: (route: Route) => void
  route: Screen
}): JSX.Element {
  const [doc, setDoc] = useState<DocumentView | null>(null)
  const [meta, setMeta] = useState<DocumentPublication | null>(null)
  const [cover, setCover] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = useCallback(() => {
    void Promise.all([window.opencourse.getDocument(documentId), window.opencourse.documentPublication(documentId)])
      .then(async ([d, m]) => {
        setDoc(d); setMeta(m)
        setCover(d.origin
          ? await window.opencourse.getDocumentCatalogCover(d.origin.connectionId, d.origin.remoteId, d.origin.version).catch(() => null)
          : await window.opencourse.documentCoverPreview(documentId).catch(() => null))
      })
      .catch((e) => setError((e as Error).message))
  }, [documentId])
  useEffect(load, [load])
  useEffect(() => window.opencourse.onDocumentsChanged((id) => { if (!id || id === documentId) load() }), [documentId, load])

  const back = { label: 'Documents', onClick: () => navigate({ name: 'documents', source: doc?.origin?.connectionId ?? 'local' }) }
  if (!doc || !meta) {
    return <>
      <TitleBar user={user} navigate={navigate} route={route} back={back} />
      <div className="body"><div className="content scroll"><div className="detail">{error ? <p className="import-note error" role="alert">{error}</p> : <p className="meta">Loading…</p>}</div></div></div>
    </>
  }

  const percent = documentProgressPercent(doc)
  const started = doc.readPage > 0 || doc.lastPage > 1
  const openAt = (page: number): void => { void window.opencourse.setDocumentPage(documentId, page).catch(() => {}).finally(() => navigate({ name: 'document', documentId })) }
  const remove = async (): Promise<void> => {
    const message = doc.origin
      ? `Remove “${doc.title}” from My learning on ${doc.origin.name}? Every device and the server’s website stop listing it, and its download is removed from this device. Your progress and chats are kept.`
      : `Delete “${doc.title}” and its chats from this library? The original PDF is kept.`
    if (!window.confirm(message)) return
    setRemoving(true); setError(null)
    try {
      if (doc.origin) {
        const r = await window.opencourse.leaveServerDocument(documentId)
        if (!r.ok) { setError(r.message); return }
        await window.opencourse.removeLearningDownload(documentId)
      } else {
        await window.opencourse.removeDocument(documentId)
      }
      navigate({ name: 'documents', source: doc.origin?.connectionId ?? 'local' })
    } catch (e) { setError((e as Error).message) }
    finally { setRemoving(false) }
  }

  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={back} />
    <div className="body">
      <div className="content scroll">
        <div className="detail document-detail">
          <DocumentServerPanel document={doc} meta={meta} navigate={navigate} onChanged={load}
            actions={!doc.origin && <ActionButton icon="edit" className="secondary" onClick={() => setEditing((value) => !value)}>{editing ? 'Close overview' : 'Edit overview'}</ActionButton>}
            trailingActions={<ActionButton icon={doc.origin ? 'close' : 'trash'} className={doc.origin ? 'secondary' : 'secondary danger'} disabled={removing} onClick={() => void remove()}>{doc.origin ? 'Remove from My learning' : 'Delete document'}</ActionButton>} />
          {cover && <img className="catalog-detail-cover" src={cover} alt="" />}
          <h1>{doc.title}</h1>
          <div className="meta">
            PDF · {doc.pages === 1 ? '1 page' : `${doc.pages} pages`} · {documentSize(doc.bytes)}
            {doc.status === 'indexing' ? ' · Building search index…' : doc.status === 'error' ? ' · Text index unavailable' : doc.searchablePages === 0 ? ' · Image-only PDF' : ''}
          </div>
          {meta.tags.length > 0 && <div className="course-card-tags">{meta.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>}
          {meta.description && <CourseDescription key={`${documentId}:${meta.version}`} source={meta.description} />}
          {error && <p className="import-note error" role="alert">{error}</p>}
          {note && <p className="import-note" role="status">{note}</p>}

          <div className="summary">
            <div className="course-progress">
              <div className="progress-bar"><span style={{ width: `${percent}%` }} /></div>
              <div className="meta" style={{ marginTop: '0.35rem' }}>
                {percent}% read{doc.readPage ? ` · read to page ${doc.readPage} of ${doc.pages}` : ''}
              </div>
            </div>
            <ActionButton icon="play" className="course-continue" onClick={() => navigate({ name: 'document', documentId })}>{started ? 'Continue reading' : 'Start reading'}</ActionButton>
          </div>

          {editing && !doc.origin && <OverviewForm document={doc} meta={meta} cover={cover} onSaved={(next, view) => { setMeta(next); if (view) setDoc(view); setNote('Overview saved.'); load() }} onError={setError} />}

          {doc.sections.length > 0 && (
            <div className="panel">
              <h2>Contents</h2>
              {doc.sections.map((section) => (
                <button className="lesson-row catalog-row document-outline-row" key={section.id} style={{ paddingLeft: `${0.5 + Math.min(section.depth, 4)}rem` }} onClick={() => openAt(section.page)}>
                  <span>{section.title}</span>
                  <span className="mins">p. {section.page}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  </>
}

/** The overview a publication carries: title, description, tags, version and preview image. */
function OverviewForm({ document, meta, cover, onSaved, onError }: {
  document: DocumentView; meta: DocumentPublication; cover: string | null
  onSaved: (meta: DocumentPublication, view?: DocumentView) => void; onError: (message: string) => void
}): JSX.Element {
  const [title, setTitle] = useState(document.title)
  const [description, setDescription] = useState(meta.description)
  const [tags, setTags] = useState(meta.tags.join(', '))
  const [version, setVersion] = useState(meta.version)
  const [busy, setBusy] = useState(false)
  const values = () => ({ description, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), version: version.trim(), releaseNote: meta.releaseNote ?? '' })
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await work() } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="panel course-server-panel document-overview-form" role="region" aria-label="Overview">
      <h2>Overview</h2>
      <p className="meta">What a server’s catalog shows about this document when you publish it.</p>
      <label className="server-field">Title<input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="server-field">Description (Markdown)<textarea rows={5} maxLength={20000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="server-field">Tags, separated by commas<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
      <label className="server-field">Version<input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" /></label>
      <div className="document-overview-cover">
        {cover ? <img src={cover} alt="Preview image" /> : <span className="meta">No preview image</span>}
        <ActionButton icon="upload" className="secondary" disabled={busy} onClick={() => void run(async () => {
          await window.opencourse.saveDocumentPublication(document.id, values())
          onSaved(await window.opencourse.chooseDocumentCover(document.id))
        })}>Choose preview image</ActionButton>
      </div>
      <div className="actions">
        <ActionButton icon="check" disabled={busy || !title.trim()} onClick={() => void run(async () => {
          const view = title.trim() !== document.title ? await window.opencourse.renameDocument(document.id, title.trim()) : undefined
          onSaved(await window.opencourse.saveDocumentPublication(document.id, values()), view)
        })}>Save overview</ActionButton>
      </div>
    </div>
  )
}

/**
 * The server half of a document's page, CourseServerPanel's twin: where it
 * came from and which version, updating it, publishing it, and the way to
 * manage what was published. Each opens a panel that says what will happen.
 */
function DocumentServerPanel({ document, meta, navigate, actions, trailingActions, onChanged }: {
  document: DocumentView; meta: DocumentPublication; navigate: (r: Route) => void
  actions?: ReactNode; trailingActions?: ReactNode; onChanged: () => void
}): JSX.Element {
  const [servers, setServers] = useState<ServerConnection[]>([])
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [panel, setPanel] = useState<'update' | 'publish' | null>(null)
  const origin = document.origin
  const refresh = useCallback(() => {
    void window.opencourse.listServers().then(setServers).catch(() => setServers([]))
    if (origin) void window.opencourse.checkDocumentUpdates().then((all) => setUpdate(all[document.id] ?? null)).catch(() => {})
  }, [document.id, origin?.version])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onServersChanged(refresh), [refresh])

  const homes = servers.filter((s) => meta.publications[s.id])
  const updateOffered = update?.kind === 'update' || update?.kind === 'switch'
  return (
    <>
      <div className="course-server-toolbar">
        <div className="course-card-origin course-origin-line">
          <span className={`origin-badge${origin ? ' from-server' : ''}`}>{origin ? origin.name : 'Local'}</span>
          <span className="version-badge">v{origin?.version ?? meta.version}</span>
          {!origin && homes.length > 0 && <span className="meta">Published by you on {homes.map((s) => s.name).join(', ')}</span>}
          {update?.kind === 'unlisted' && <span className="update-badge muted">No longer published</span>}
          {update?.kind === 'disconnected' && <span className="update-badge muted">{update.reason === 'not-connected' ? 'Server not connected' : 'Could not check for updates'}</span>}
          {update?.kind === 'current' && <span className="meta">Up to date</span>}
        </div>
        <div className="actions course-server-actions">
          {actions}
          {updateOffered && <ActionButton icon="refresh" onClick={() => setPanel(panel === 'update' ? null : 'update')}>{update.kind === 'update' ? `Update to v${update.version}` : `Switch to v${update.version}`}</ActionButton>}
          {!origin && <ActionButton icon="upload" className="secondary" onClick={() => setPanel(panel === 'publish' ? null : 'publish')}>{homes.length ? 'Publish a new version' : 'Publish'}</ActionButton>}
          {homes.map((home) => (
            <ActionButton key={home.id} icon="settings" className="secondary" onClick={() => navigate({ name: 'documentPublication', serverId: home.id, documentId: meta.publications[home.id]! })}>
              {homes.length > 1 ? `Manage on ${home.name}` : 'Manage publication'}
            </ActionButton>
          ))}
          {trailingActions}
        </div>
      </div>
      {panel === 'update' && updateOffered && <UpdatePanel document={document} target={update.version} rolledBack={update.kind === 'switch'} onDone={() => { setPanel(null); refresh(); onChanged() }} />}
      {panel === 'publish' && <PublishPanel document={document} meta={meta} servers={servers} homes={homes} onDone={() => { setPanel(null); refresh(); onChanged() }} />}
    </>
  )
}

function UpdatePanel({ document, target, rolledBack, onDone }: { document: DocumentView; target: string; rolledBack: boolean; onDone: () => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const install = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const r = await window.opencourse.applyDocumentUpdate(document.id)
      if (r.ok) onDone()
      else setError(r.message)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="panel course-server-panel" role="region" aria-label="Update">
      <h2>{rolledBack ? `Switch to v${target}` : `Update to v${target}`}</h2>
      {rolledBack && <p className="meta">The publisher made an earlier version current again. Switching installs it in place of the one you have.</p>}
      <p>Your place and what you have read carry over when only the overview changed. If the PDF itself changed, v{target} keeps its own progress, and v{document.origin?.version} keeps yours.</p>
      <p className="meta">Every device signed in to this account switches with you, and so does the server’s website. Your chats stay.</p>
      {error && <p className="import-note error" role="alert">{error}</p>}
      <div className="actions">
        <ActionButton icon="download" disabled={busy} onClick={() => void install()}>{busy ? 'Installing' : rolledBack ? `Switch to v${target}` : `Install v${target}`}</ActionButton>
        <ActionButton icon="close" className="secondary" disabled={busy} onClick={onDone}>Cancel</ActionButton>
      </div>
    </div>
  )
}

function PublishPanel({ document, meta, servers, homes, onDone }: { document: DocumentView; meta: DocumentPublication; servers: ServerConnection[]; homes: ServerConnection[]; onDone: () => void }): JSX.Element {
  const choices = servers.filter((s) => s.account && (!s.capabilities || s.capabilities.includes('documents-v1')))
  // Derived on every render: the server list may arrive after the panel opens.
  const [chosen, setServerId] = useState<string>('')
  const serverId = choices.some((s) => s.id === chosen) ? chosen : homes.find((h) => choices.some((c) => c.id === h.id))?.id ?? choices.find((s) => s.active)?.id ?? choices[0]?.id ?? ''
  const [preview, setPreview] = useState<DocumentPublishPreview | null>(null)
  // Each version says what changed in it; the last one's note is not this one's.
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!serverId) return undefined
    let alive = true
    setPreview(null); setError(null)
    void window.opencourse.previewDocumentPublish(document.id, serverId).then((r) => { if (!alive) return; if (r.ok) setPreview(r.value); else setError(r.message) })
      .catch((err: Error) => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [document.id, serverId, meta.version])

  const publish = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const r = await window.opencourse.publishLocalDocument(document.id, serverId, note)
      if (r.ok) setDone(`Published v${r.value.document.version}${r.value.created ? ` - ${r.value.document.title} is now in the catalog of ${preview?.serverName}` : ''}. Its search index is built on the server; reading works meanwhile.`)
      else setError(r.message)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  if (!choices.length) {
    return <div className="panel course-server-panel"><h2>Publish</h2><p className="meta">Connect to a server that offers documents and sign in, in Settings → Servers, to publish this document.</p><div className="actions"><ActionButton icon="close" className="secondary" onClick={onDone}>Close</ActionButton></div></div>
  }
  return (
    <div className="panel course-server-panel" role="region" aria-label="Publish">
      <h2>{homes.length === 1 && homes[0]!.id === serverId ? `Publish a new version to ${homes[0]!.name}` : 'Publish to a server'}</h2>
      {choices.length > 1 && (
        <label className="server-field">Server
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>{choices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
      )}
      {done ? <p className="import-note" role="status">{done}</p> : <>
        {!preview && !error && <p className="meta">Checking…</p>}
        {preview && <>
          <p className="meta">Publishing v{preview.version}{preview.maxVersion ? ` (highest published: v${preview.maxVersion})` : ' - its first version'}. Everyone connected to {preview.serverName} can then add it and read it, here or on the server’s website. Versions can only go up: to publish again, raise the version under Edit overview.</p>
          {preview.problems.map((p) => <p key={p} className="import-note error">{p}</p>)}
          <label className="server-field">What changed in this version (optional)
            <textarea rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </>}
        {error && <p className="import-note error" role="alert">{error}</p>}
      </>}
      <div className="actions">
        {!done && <ActionButton icon="upload" disabled={!preview || preview.problems.length > 0 || busy} onClick={() => void publish()}>{busy ? 'Publishing' : `Publish v${preview?.version ?? ''}`}</ActionButton>}
        <ActionButton icon="close" className="secondary" disabled={busy} onClick={onDone}>{done ? 'Close' : 'Cancel'}</ActionButton>
      </div>
    </div>
  )
}
