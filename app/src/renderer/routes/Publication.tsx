import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ManagedCourse, VersionEntry } from '@core/catalog/api'
import type { ServerResult, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { ConfirmRequest } from '../components/ConfirmDialog'
import type { Route, Screen } from '../routes'

const STATUS: Record<VersionEntry['status'], string> = { current: 'Current', available: 'Available', withdrawn: 'Withdrawn', deleted: 'Deleted' }

/**
 * Everything a publisher can do to a published course: see every version and
 * who added it, make another version current (a rollback, or forward again),
 * delete a version, unpublish the course or list it again. Nothing here edits
 * content - that is the editor, then a new version.
 */
export default function Publication({ serverId, courseId, user, navigate, route, ask }: {
  serverId: string; courseId: string; user: UserProfile | null; navigate: (r: Route) => void; route: Screen
  ask: (request: ConfirmRequest) => Promise<boolean>
}): JSX.Element {
  const [course, setCourse] = useState<ManagedCourse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (result: ServerResult<ManagedCourse>): void => { if (result.ok) { setCourse(result.value); setError(null) } else setError(result.message) }
  const load = useCallback(() => { void window.opencourse.getPublishedCourse(serverId, courseId).then(take) }, [serverId, courseId])
  useEffect(load, [load])

  const run = async (question: ConfirmRequest | null, work: () => Promise<ServerResult<ManagedCourse>>): Promise<void> => {
    if (question && !(await ask(question))) return
    setBusy(true)
    try { take(await work()) } finally { setBusy(false) }
  }

  const back = { label: 'Back', onClick: () => navigate({ name: 'course', courseId }) }
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={back} />
    <div className="body">
      <div className="content scroll">
        <div className="detail publication">
          <h1>{course ? course.title : 'Publication'}</h1>
          {course && <p className="meta">
            {course.listed ? `Listed in the catalog at v${course.currentVersion}` : 'Not listed: nobody can find or add it, and those who have it get no updates.'}
            {` · ${course.downloads === 1 ? '1 download' : `${course.downloads} downloads`} · highest version published: v${course.maxVersion}`}
          </p>}
          {error && <p className="import-note error" role="alert">{error}</p>}
          {course && <>
            <table className="publication-versions">
              <thead><tr><th>Version</th><th>Published</th><th>Downloads</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                {course.versions.map((v) => (
                  <tr key={v.version} className={v.status}>
                    <td><strong>v{v.version}</strong>{v.releaseNote && <p className="meta publication-note">{v.releaseNote}</p>}</td>
                    <td>{v.publishedAt.slice(0, 10)}</td>
                    <td>{v.downloads ?? 0}</td>
                    <td><span className={`update-badge${v.status === 'current' ? ' update' : ''}`}>{STATUS[v.status]}</span></td>
                    <td><div className="publication-actions">
                      {v.status !== 'current' && v.status !== 'deleted' && <button className="secondary" disabled={busy} onClick={() => void run(
                        { title: `Make v${v.version} current?`, detail: v.status === 'withdrawn' ? `v${v.version} becomes what learners get again.` : `Learners who add or update the course get v${v.version}. Newer versions stay, withdrawn, and can be made current again.`, confirmLabel: 'Make current', cancelLabel: 'Cancel' },
                        () => window.opencourse.setCurrentPublishedVersion(serverId, courseId, v.version))}>Make current</button>}
                      {v.status !== 'current' && v.status !== 'deleted' && <button className="secondary danger" disabled={busy} onClick={() => void run(
                        { title: `Delete v${v.version}?`, detail: `Its archive is deleted from the server. Learners who installed it keep their copy. The number v${v.version} can never be published again.`, confirmLabel: 'Delete version', cancelLabel: 'Cancel', danger: true },
                        () => window.opencourse.deletePublishedVersion(serverId, courseId, v.version))}>Delete</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">To publish a change, edit the course, raise its version and choose Publish a new version on its page. The current version cannot be deleted; make another one current first, or unpublish the course.</p>
            <div className="actions">
              {course.listed
                ? <button className="secondary danger" disabled={busy} onClick={() => void run(
                    { title: 'Unpublish this course?', detail: 'It leaves the catalog and nobody can add it. Learners who have it keep their copy but get no updates. Nothing is deleted; you can list it again.', confirmLabel: 'Unpublish', cancelLabel: 'Cancel', danger: true },
                    () => window.opencourse.unpublishCourse(serverId, courseId))}>Unpublish course</button>
                : <button disabled={busy || !course.currentVersion} onClick={() => void run(null, () => window.opencourse.relistCourse(serverId, courseId))}>List in the catalog again</button>}
            </div>
          </>}
        </div>
      </div>
    </div>
  </>
}
