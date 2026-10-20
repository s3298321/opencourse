import { useState } from 'react'
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router'
import { ArrowLeft, ArrowUpRight, ChevronRight, Download, EyeOff, Eye, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react'
import type { ManagedCourse, VersionEntry } from '@core/catalog/api'
import type { PublishedDocument } from '@core/learning/types'
import { api, ApiError } from '../lib/api'
import { server } from '../lib/boot'
import { requireAccount, signedIn } from '../lib/guards'
import { ago, compact, date, plural } from '../lib/format'
import { Cover } from '../components/Cover'
import { Dialog } from '../components/Dialog'
import { EmptyState, PageHeader, Stat, useTitle } from '../components/Bits'
import { useToast } from '../components/Toasts'

export interface Publications { courses: ManagedCourse[]; documents: PublishedDocument[] }

export async function myCoursesLoader({ request }: LoaderFunctionArgs): Promise<Publications> {
  requireAccount(request)
  return signedIn(request, async () => {
    const [courses, documents] = await Promise.all([api.myCourses(), api.myDocuments()])
    return { courses: courses.courses, documents: documents.documents }
  })
}

export async function myDocumentLoader({ request, params }: LoaderFunctionArgs): Promise<PublishedDocument> {
  requireAccount(request)
  const document = await signedIn(request, () => api.managedDocument(params['id'] ?? ''))
  if (!document.ownedByYou) throw new Response('Not found', { status: 404 })
  return document
}

export async function myCourseLoader({ request, params }: LoaderFunctionArgs): Promise<ManagedCourse> {
  requireAccount(request)
  return signedIn(request, () => api.managed(params['id'] ?? ''))
}

export function StatusPill({ course }: { course: ManagedCourse }) {
  if (course.moderation) return <span className="oc-pill err"><span className="dot" />Removed by a moderator</span>
  if (!course.currentVersion) return <span className="oc-pill"><span className="dot" />No version</span>
  if (!course.listed) return <span className="oc-pill"><span className="dot" />Unlisted</span>
  return <span className="oc-pill ok"><span className="dot" />Listed</span>
}

export function DocumentStatusPill({ document }: { document: PublishedDocument }) {
  if (document.moderated) return <span className="oc-pill err"><span className="dot" />Removed by a moderator</span>
  if (!document.listed) return <span className="oc-pill"><span className="dot" />Unlisted</span>
  return <span className="oc-pill ok"><span className="dot" />Listed</span>
}

export function MyCoursesPage() {
  const { courses, documents } = useLoaderData() as Publications
  useTitle('My publications')
  return (
    <div className="oc-wrap page">
      <PageHeader title="My publications" />
      {courses.length === 0 && documents.length === 0 ? (
        <EmptyState title="You have not published anything yet" actions={<a className="oc-btn" href={server.appUrl}><Download aria-hidden />Get OpenCourse</a>}>
          Publishing happens in the OpenCourse app: open a course in its editor, or a PDF under Documents, then choose <strong>Publish</strong> and pick this server. Each new version shows up here, where you can roll back, unlist or remove it.
        </EmptyState>
      ) : <div className="publication-sections">
        {courses.length > 0 && <section className="panel-section">
          <div className="section-head"><h2>Courses</h2></div>
          <ul className="row-list oc-stagger">
            {courses.map((course) => (
              <li key={course.id}>
                <Link to={`/me/courses/${encodeURIComponent(course.id)}`} className="row-card oc-card oc-glow" data-glow viewTransition>
                  <Cover id={course.id} title={course.title} hasCover={Boolean(course.hasCover)} className="row-thumb" />
                  <div className="row-main">
                    <strong className="row-title">{course.title}</strong>
                    <span className="row-meta">{course.currentVersion ? `Version ${course.currentVersion}` : 'Every version deleted'}{course.updatedAt ? ` · updated ${ago(course.updatedAt)}` : ''}</span>
                  </div>
                  <StatusPill course={course} />
                  <span className="row-stat"><Download aria-hidden />{compact(course.downloads)}</span>
                  <ChevronRight aria-hidden className="row-chevron" />
                </Link>
              </li>
            ))}
          </ul>
        </section>}
        {documents.length > 0 && <section className="panel-section">
          <div className="section-head"><h2>Documents</h2></div>
          <ul className="row-list oc-stagger">
            {documents.map((document) => (
              <li key={document.id}>
                <Link to={`/me/documents/${encodeURIComponent(document.id)}`} className="row-card oc-card oc-glow" data-glow viewTransition>
                  <Cover id={document.id} kind="document" title={document.title} hasCover={document.hasCover} className="row-thumb" />
                  <div className="row-main">
                    <strong className="row-title">{document.title}</strong>
                    <span className="row-meta">Version {document.version} · {plural(document.pages, 'page')}{document.updatedAt ? ` · updated ${ago(document.updatedAt)}` : ''}</span>
                  </div>
                  <DocumentStatusPill document={document} />
                  <span className="row-stat"><Download aria-hidden />{compact(document.downloads)}</span>
                  <ChevronRight aria-hidden className="row-chevron" />
                </Link>
              </li>
            ))}
          </ul>
        </section>}
      </div>}
    </div>
  )
}

const INDEX: Record<PublishedDocument['status'], string> = { indexing: 'Building the search index', ready: 'Searchable', error: 'Search index failed' }
type DocumentPending = { kind: 'current' | 'delete'; version: string } | { kind: 'unpublish' } | null

/** A published document, managed like a course: versions, rollback, unlisting, and its search index. */
export function MyDocumentPage() {
  const document = useLoaderData() as PublishedDocument
  const revalidator = useRevalidator()
  const notify = useToast()
  const [pending, setPending] = useState<DocumentPending>(null)
  const [busy, setBusy] = useState(false)
  useTitle(document.title)

  const act = async (work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await work()
      notify(done)
      setPending(null)
      revalidator.revalidate()
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'That did not work. Try again.', 'err')
    } finally { setBusy(false) }
  }
  const live = document.versions.filter((v) => !v.deleted)

  return (
    <div className="oc-wrap page">
      <Link to="/me/courses" className="back-link" viewTransition><ArrowLeft aria-hidden />My publications</Link>
      <PageHeader
        eyebrow={<DocumentStatusPill document={document} />}
        title={document.title}
        description={<>Document id <code>{document.id}</code></>}
        actions={<>
          {document.listed && <Link className="oc-btn secondary" to={`/documents/${encodeURIComponent(document.id)}`} viewTransition><ArrowUpRight aria-hidden />View in catalog</Link>}
          {document.listed && <button type="button" className="oc-btn secondary" onClick={() => setPending({ kind: 'unpublish' })}><EyeOff aria-hidden />Unlist</button>}
          {!document.listed && !document.moderated && live.length > 0 && <button type="button" className="oc-btn" disabled={busy} onClick={() => { void act(() => api.relistDocument(document.id), 'Listed in the catalog again.') }}><Eye aria-hidden />List again</button>}
        </>}
      />

      {document.moderated && (
        <div className="callout err oc-enter">
          <ShieldAlert aria-hidden />
          <div>
            <strong>A moderator removed this document from the catalog.</strong>
            <p className="muted">Readers who downloaded it keep their copy. Only a moderator can list it again.</p>
          </div>
        </div>
      )}

      <div className="stat-row oc-enter">
        <Stat label="Current version" value={document.version} />
        <Stat label="Highest published" value={document.maxVersion} />
        <Stat label={document.downloads === 1 ? 'Reader' : 'Readers'} value={compact(document.downloads)} />
        <Stat label="Search" value={INDEX[document.status]} />
      </div>
      {document.status === 'error' && (
        <div className="callout err oc-enter">
          <ShieldAlert aria-hidden />
          <div>
            <strong>{document.error ?? 'The search index could not be built.'}</strong>
            <p className="muted">Reading works without it; searching and the study chat's look-ups do not.</p>
            <button type="button" className="oc-btn secondary sm" disabled={busy} onClick={() => { void act(() => api.reindexDocument(document.id, document.version), 'Building the search index again.') }}><RotateCcw aria-hidden />Retry</button>
          </div>
        </div>
      )}

      <section className="panel-section">
        <div className="section-head"><h2>Versions</h2><p className="muted">Readers who add or update the document get the current version. Rolling back changes which one that is; it deletes nothing.</p></div>
        <ol className="version-list">
          {document.versions.map((v) => {
            const status = v.deleted ? 'deleted' : v.version === document.version ? 'current' : 'available'
            return (
              <li key={v.version} className={`version-row oc-card ${status}`}>
                <div className="version-main">
                  <div className="version-head">
                    <strong>{v.version}</strong>
                    {status === 'current' && <span className="oc-pill ok"><span className="dot" />Current</span>}
                    {status === 'deleted' && <span className="oc-pill">Deleted</span>}
                    <span className="muted">{date(v.publishedAt)}</span>
                  </div>
                  {v.releaseNote && <p className="version-note">{v.releaseNote}</p>}
                </div>
                {status === 'available' && (
                  <div className="version-actions">
                    <button type="button" className="oc-btn secondary sm" onClick={() => setPending({ kind: 'current', version: v.version })}><RotateCcw aria-hidden />Make current</button>
                    <button type="button" className="oc-btn ghost sm danger-text" aria-label={`Delete version ${v.version}`} onClick={() => setPending({ kind: 'delete', version: v.version })}><Trash2 aria-hidden /></button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <p className="muted small">New versions are published from the OpenCourse app, under Documents, and must be higher than {document.maxVersion}.</p>
      </section>

      <Dialog
        open={pending?.kind === 'current'}
        onClose={() => setPending(null)}
        title={pending?.kind === 'current' ? `Make ${pending.version} current?` : ''}
        description="Readers who add or update the document get this version from now on. Their place carries over when the PDF is the same; a changed PDF keeps its own progress."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn" disabled={busy} onClick={() => { if (pending?.kind === 'current') void act(() => api.makeDocumentCurrent(document.id, pending.version), `${pending.version} is now current.`) }}>Make current</button></>}
      />
      <Dialog
        open={pending?.kind === 'delete'}
        onClose={() => setPending(null)}
        tone="danger"
        title={pending?.kind === 'delete' ? `Delete version ${pending.version}?` : ''}
        description="Its PDF is removed from the server, and reading it here stops for everyone. Downloaded copies stay. The number stays taken: the next version must still be higher."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn danger-solid" disabled={busy} onClick={() => { if (pending?.kind === 'delete') void act(() => api.deleteDocumentVersion(document.id, pending.version), `Version ${pending.version} deleted.`) }}>Delete version</button></>}
      />
      <Dialog
        open={pending?.kind === 'unpublish'}
        onClose={() => setPending(null)}
        title="Unlist this document?"
        description="It disappears from the catalog and from search. Nothing is deleted, readers who added it keep reading it, and you can list it again at any time."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn" disabled={busy} onClick={() => { void act(() => api.unpublishDocument(document.id), 'Unlisted. It is no longer in the catalog.') }}>Unlist</button></>}
      />
    </div>
  )
}

type Pending = { kind: 'current' | 'delete'; version: VersionEntry } | { kind: 'unpublish' } | null

export function MyCoursePage() {
  const course = useLoaderData() as ManagedCourse
  const revalidator = useRevalidator()
  const notify = useToast()
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  useTitle(course.title)

  const act = async (work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await work()
      notify(done)
      setPending(null)
      revalidator.revalidate()
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'That did not work. Try again.', 'err')
    } finally { setBusy(false) }
  }
  const live = course.versions.filter((v) => v.status !== 'deleted')

  return (
    <div className="oc-wrap page">
      <Link to="/me/courses" className="back-link" viewTransition><ArrowLeft aria-hidden />My publications</Link>
      <PageHeader
        eyebrow={<StatusPill course={course} />}
        title={course.title}
        description={<>Course id <code>{course.id}</code></>}
        actions={<>
          {course.listed && <Link className="oc-btn secondary" to={`/courses/${encodeURIComponent(course.id)}`} viewTransition><ArrowUpRight aria-hidden />View in catalog</Link>}
          {course.listed && <button type="button" className="oc-btn secondary" onClick={() => setPending({ kind: 'unpublish' })}><EyeOff aria-hidden />Unlist</button>}
          {!course.listed && !course.moderation && course.currentVersion && <button type="button" className="oc-btn" disabled={busy} onClick={() => { void act(() => api.relist(course.id), 'Listed in the catalog again.') }}><Eye aria-hidden />List again</button>}
        </>}
      />

      {course.moderation && (
        <div className="callout err oc-enter">
          <ShieldAlert aria-hidden />
          <div>
            <strong>A moderator removed this course from the catalog on {date(course.moderation.at)}.</strong>
            <p>{course.moderation.reason}</p>
            <p className="muted">Learners who added it keep their copy. Only a moderator can list it again.</p>
          </div>
        </div>
      )}

      <div className="stat-row oc-enter">
        <Stat label="Current version" value={course.currentVersion ?? '–'} />
        <Stat label="Highest published" value={course.maxVersion} />
        <Stat label={course.downloads === 1 ? 'Learner' : 'Learners'} value={compact(course.downloads)} />
        <Stat label="Versions kept" value={live.length} />
      </div>

      <section className="panel-section">
        <div className="section-head"><h2>Versions</h2><p className="muted">Learners always get the current version. Rolling back changes which one that is; it deletes nothing.</p></div>
        <ol className="version-list">
          {course.versions.map((v) => (
            <li key={v.version} className={`version-row oc-card ${v.status}`}>
              <div className="version-main">
                <div className="version-head">
                  <strong>{v.version}</strong>
                  {v.status === 'current' && <span className="oc-pill ok"><span className="dot" />Current</span>}
                  {v.status === 'withdrawn' && <span className="oc-pill">Newer than current</span>}
                  {v.status === 'deleted' && <span className="oc-pill">Deleted</span>}
                  <span className="muted">{date(v.publishedAt)}{v.downloads !== undefined ? ` · ${plural(v.downloads, 'learner')}` : ''}</span>
                </div>
                {v.releaseNote && <p className="version-note">{v.releaseNote}</p>}
              </div>
              {v.status !== 'deleted' && v.status !== 'current' && (
                <div className="version-actions">
                  <button type="button" className="oc-btn secondary sm" onClick={() => setPending({ kind: 'current', version: v })}><RotateCcw aria-hidden />Make current</button>
                  <button type="button" className="oc-btn ghost sm danger-text" aria-label={`Delete version ${v.version}`} onClick={() => setPending({ kind: 'delete', version: v })}><Trash2 aria-hidden /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="muted small">New versions are published from the OpenCourse app's editor, and must be higher than {course.maxVersion}.</p>
      </section>

      <Dialog
        open={pending?.kind === 'current'}
        onClose={() => setPending(null)}
        title={pending?.kind === 'current' ? `Make ${pending.version.version} current?` : ''}
        description="Learners who add or update the course get this version from now on. Their progress follows them."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn" disabled={busy} onClick={() => { if (pending?.kind === 'current') void act(() => api.makeCurrent(course.id, pending.version.version), `${pending.version.version} is now current.`) }}>Make current</button></>}
      />
      <Dialog
        open={pending?.kind === 'delete'}
        onClose={() => setPending(null)}
        tone="danger"
        title={pending?.kind === 'delete' ? `Delete version ${pending.version.version}?` : ''}
        description="Its archive is removed from the server. The number stays taken: the next version must still be higher."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn danger-solid" disabled={busy} onClick={() => { if (pending?.kind === 'delete') void act(() => api.deleteVersion(course.id, pending.version.version), `Version ${pending.version.version} deleted.`) }}>Delete version</button></>}
      />
      <Dialog
        open={pending?.kind === 'unpublish'}
        onClose={() => setPending(null)}
        title="Unlist this course?"
        description="It disappears from the catalog and from search. Nothing is deleted, learners keep their copies, and you can list it again at any time."
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setPending(null)}>Cancel</button><button type="button" className="oc-btn" disabled={busy} onClick={() => { void act(() => api.unpublish(course.id), 'Unlisted. It is no longer in the catalog.') }}>Unlist</button></>}
      />
    </div>
  )
}
