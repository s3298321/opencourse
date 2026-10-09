import { useCallback, useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { UpdateState } from '@core/catalog/origin'
import type { CourseUpdatePreview, CourseView, PublishPreview, ServerConnection } from '@core/types'
import type { Route } from '../routes'

/**
 * A course page's server half: where the course came from and which version
 * it is, updating it, publishing it, and the way to manage what was published.
 * Update and publish each open a panel that says exactly what will happen
 * before it happens.
 */
export default function CourseServerPanel({ course, navigate, actions }: { course: CourseView; navigate: (r: Route) => void; actions?: ReactNode }): JSX.Element {
  const [servers, setServers] = useState<ServerConnection[]>([])
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [panel, setPanel] = useState<'update' | 'publish' | null>(null)
  const origin = course.origin
  const home = origin ? servers.find((s) => s.url === origin.server) ?? null : null

  const refresh = useCallback(() => {
    void window.opencourse.listServers().then(setServers).catch(() => setServers([]))
    if (course.origin) void window.opencourse.checkCourseUpdates().then((all) => setUpdate(all[course.courseId] ?? null)).catch(() => {})
  }, [course.courseId, course.origin])
  useEffect(refresh, [refresh, course.version])
  useEffect(() => window.opencourse.onServersChanged(refresh), [refresh])

  const canPublish = !origin || origin.role === 'publisher'
  const updateOffered = update?.kind === 'update' || update?.kind === 'switch'

  return (
    <>
      <div className="course-card-origin course-origin-line">
        <span className={`origin-badge${origin ? ' from-server' : ''}`} title={origin?.server}>{origin ? origin.serverName : 'Local'}</span>
        <span className="version-badge">v{course.version ?? '0.1.0'}</span>
        {origin && <span className="meta">{origin.role === 'publisher' ? 'Published by you' : `Published by ${origin.publisher}`}</span>}
        {update?.kind === 'unlisted' && <span className="update-badge muted">No longer published</span>}
        {update?.kind === 'disconnected' && <span className="update-badge muted">{update.reason === 'not-connected' ? 'Server not connected' : 'Could not check for updates'}</span>}
        {update?.kind === 'current' && <span className="meta">Up to date</span>}
      </div>
      <div className="actions course-server-actions">
        {actions}
        {updateOffered && <button onClick={() => setPanel(panel === 'update' ? null : 'update')}>{update.kind === 'update' ? `Update to v${update.version}` : `Switch to v${update.version}`}</button>}
        {canPublish && <button className="secondary" onClick={() => setPanel(panel === 'publish' ? null : 'publish')}>{origin ? 'Publish a new version' : 'Publish'}</button>}
        {origin?.role === 'publisher' && home && <button className="secondary" onClick={() => navigate({ name: 'publication', serverId: home.id, courseId: course.courseId })}>Manage publication</button>}
      </div>
      {panel === 'update' && updateOffered && <UpdatePanel course={course} target={update.version} rolledBack={update.kind === 'switch'} onDone={() => { setPanel(null); refresh() }} />}
      {panel === 'publish' && <PublishPanel course={course} servers={servers} fixed={home} onDone={() => { setPanel(null); refresh() }} />}
    </>
  )
}

function UpdatePanel({ course, target, rolledBack, onDone }: { course: CourseView; target: string; rolledBack: boolean; onDone: () => void }): JSX.Element {
  const [preview, setPreview] = useState<CourseUpdatePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.opencourse.previewCourseUpdate(course.courseId).then((r) => { if (!alive) return; if (r.ok) setPreview(r.value); else setError(r.message) })
      .catch((err: Error) => { if (alive) setError(err.message) })
    return () => { alive = false; void window.opencourse.cancelCourseUpdate(course.courseId).catch(() => {}) }
  }, [course.courseId])

  const install = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const r = await window.opencourse.applyCourseUpdate(course.courseId)
      if (r.ok) onDone()
      else setError(r.message)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="panel course-server-panel" role="region" aria-label="Update">
      <h2>{rolledBack ? `Switch to v${target}` : `Update to v${target}`}</h2>
      {rolledBack && <p className="meta">The author made an earlier version current again. Switching installs it in place of the one you have.</p>}
      {!preview && !error && <p className="meta">Downloading v{target}…</p>}
      {preview && <>
        <p>Everything you have done in lessons, quizzes, exercises and projects that are still in v{preview.to} is kept, even where they changed.</p>
        {(preview.newLessons > 0 || preview.newProjects > 0) && <p className="meta">New: {[preview.newLessons && `${preview.newLessons} lessons`, preview.newProjects && `${preview.newProjects} projects`].filter(Boolean).join(', ')} - they start incomplete.</p>}
        {preview.removed.length > 0 && <>
          <p className="update-warning">v{preview.to} removes {preview.removed.length} item{preview.removed.length === 1 ? '' : 's'}. Their progress{preview.messages ? `, ${preview.messages} chat messages` : ''}{preview.workspaces ? ` and ${preview.workspaces} exercise or project folders` : ''} will be deleted:</p>
          <ul className="update-removed">{preview.removed.slice(0, 12).map((n) => <li key={n.id}>{n.label} <span className="meta">({n.kind})</span></li>)}{preview.removed.length > 12 && <li className="meta">…and {preview.removed.length - 12} more</li>}</ul>
        </>}
        {preview.overwritesLocalEdits && <p className="update-warning">You have saved edits that were never published. Installing v{preview.to} replaces them.</p>}
      </>}
      {error && <p className="import-note error" role="alert">{error}</p>}
      <div className="actions">
        <button disabled={!preview || busy} onClick={() => void install()}>{busy ? 'Installing' : rolledBack ? `Switch to v${target}` : `Install v${target}`}</button>
        <button className="secondary" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

function PublishPanel({ course, servers, fixed, onDone }: { course: CourseView; servers: ServerConnection[]; fixed: ServerConnection | null; onDone: () => void }): JSX.Element {
  const choices = fixed ? [fixed] : servers.filter((s) => s.account)
  // Derived on every render: the server list may arrive after the panel opens.
  const [chosen, setServerId] = useState<string>('')
  const serverId = choices.some((s) => s.id === chosen) ? chosen : fixed?.id ?? choices.find((s) => s.active)?.id ?? choices[0]?.id ?? ''
  const [preview, setPreview] = useState<PublishPreview | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!serverId) return undefined
    let alive = true
    setPreview(null); setError(null)
    void window.opencourse.previewPublish(course.courseId, serverId).then((r) => { if (!alive) return; if (r.ok) setPreview(r.value); else setError(r.message) })
      .catch((err: Error) => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [course.courseId, serverId, course.version])

  const publish = async (): Promise<void> => {
    setBusy(true); setError(null)
    let r: Awaited<ReturnType<typeof window.opencourse.publishCourse>>
    try { r = await window.opencourse.publishCourse(course.courseId, serverId, note) } catch (err) { setError((err as Error).message); return } finally { setBusy(false) }
    if (r.ok) setDone(`Published v${r.value.version}${r.value.created ? ` - ${preview?.title} is now in the catalog of ${preview?.serverName}` : ''}.`)
    else setError(r.errors?.length ? `${r.message} ${r.errors.slice(0, 3).join('; ')}` : r.message)
  }

  if (!choices.length) {
    return <div className="panel course-server-panel"><h2>Publish</h2><p className="meta">Connect to a server and sign in, in Settings → Servers, to publish this course.</p><div className="actions"><button className="secondary" onClick={onDone}>Close</button></div></div>
  }
  return (
    <div className="panel course-server-panel" role="region" aria-label="Publish">
      <h2>{fixed ? `Publish a new version to ${fixed.name}` : 'Publish to a server'}</h2>
      {!fixed && choices.length > 1 && (
        <label className="server-field">Server
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>{choices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
      )}
      {done ? <p className="import-note" role="status">{done}</p> : <>
        {!preview && !error && <p className="meta">Checking…</p>}
        {preview && <>
          <p className="meta">Publishing v{preview.version}{preview.maxVersion ? ` (highest published: v${preview.maxVersion})` : ' - its first version'}. Everyone connected to {preview.serverName} can then add it. Versions can only go up; to change a published course, raise its version in the editor (Course details → Version) and publish again.</p>
          {preview.problems.map((p) => <p key={p} className="import-note error">{p}</p>)}
          <label className="server-field">What changed in this version (optional)
            <textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </>}
        {error && <p className="import-note error" role="alert">{error}</p>}
      </>}
      <div className="actions">
        {!done && <button disabled={!preview || preview.problems.length > 0 || busy} onClick={() => void publish()}>{busy ? 'Publishing' : `Publish v${preview?.version ?? ''}`}</button>}
        <button className="secondary" disabled={busy} onClick={onDone}>{done ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  )
}
