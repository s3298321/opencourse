import { useState } from 'react'
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router'
import { ArrowLeft, ArrowUpRight, ChevronRight, Download, EyeOff, Eye, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react'
import type { ManagedCourse, VersionEntry } from '@core/catalog/api'
import { api, ApiError } from '../lib/api'
import { server } from '../lib/boot'
import { requireAccount, signedIn } from '../lib/guards'
import { ago, compact, date, plural } from '../lib/format'
import { Cover } from '../components/Cover'
import { Dialog } from '../components/Dialog'
import { EmptyState, PageHeader, Stat, useTitle } from '../components/Bits'
import { useToast } from '../components/Toasts'

export async function myCoursesLoader({ request }: LoaderFunctionArgs): Promise<ManagedCourse[]> {
  requireAccount(request)
  return (await signedIn(request, () => api.myCourses())).courses
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

export function MyCoursesPage() {
  const courses = useLoaderData() as ManagedCourse[]
  useTitle('My courses')
  return (
    <div className="oc-wrap page">
      <PageHeader eyebrow="Publishing" title="My courses" description={courses.length ? `${plural(courses.length, 'course')} you published on ${server.name}.` : undefined} />
      {courses.length === 0 ? (
        <EmptyState title="You have not published anything yet" actions={<a className="oc-btn" href={server.appUrl}><Download aria-hidden />Get OpenCourse</a>}>
          Publishing happens in the OpenCourse app: open a course in its editor, then choose <strong>Publish</strong> and pick this server. Each new version shows up here, where you can roll back, unlist or remove it.
        </EmptyState>
      ) : (
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
      )}
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
      <Link to="/me/courses" className="back-link" viewTransition><ArrowLeft aria-hidden />My courses</Link>
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
