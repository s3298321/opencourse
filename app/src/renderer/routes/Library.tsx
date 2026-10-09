import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CourseSummary, ImportResult, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'
import Html from '../components/Html'
import Catalog from '../components/Catalog'
import type { UpdateState } from '@core/catalog/origin'

/** What a server course's card says about its version on the server. */
function updateLabel(state: UpdateState | undefined): { text: string; tone: 'update' | 'muted' } | null {
  switch (state?.kind) {
    case 'update': return { text: `Update to v${state.version}`, tone: 'update' }
    case 'switch': return { text: `Author rolled back to v${state.version}`, tone: 'update' }
    case 'unlisted': return { text: 'No longer published', tone: 'muted' }
    case 'disconnected': return state.reason === 'not-connected' ? { text: 'Server not connected', tone: 'muted' } : null
    default: return null
  }
}

/** Import errors are the author's only feedback, so say what actually failed. */
function describe(result: ImportResult): string | null {
  switch (result.status) {
    case 'ok':
      return `Imported “${result.title}”.`
    case 'invalid':
      return `That archive isn't a valid course: ${result.message}`
    case 'rejected':
      return `That archive was refused: ${result.message}`
    case 'cancelled':
      return null
  }
}

export default function Library({
  user,
  navigate,
  importSignal,
  route
}: {
  user: UserProfile | null
  navigate: (r: Route) => void
  importSignal: number
  route: Screen
}): JSX.Element {
  const [courses, setCourses] = useState<CourseSummary[] | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({})
  const tab = route.name === 'library' ? route.tab ?? 'mine' : 'mine'

  const refresh = useCallback(() => {
    void window.opencourse.listCourses().then((list) => {
      setCourses(list)
      // Only server courses have anything to ask a server about.
      if (list.some((c) => c.origin)) void window.opencourse.checkCourseUpdates().then(setUpdates).catch(() => {})
    }).catch((error) => setNote({ text: `The library could not be loaded. Your data is retained. ${error.message}`, error: true }))
  }, [])

  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onCoursesChanged(refresh), [refresh])

  const runImport = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await window.opencourse.importCourse()
      const text = describe(result)
      if (text) setNote({ text, error: result.status !== 'ok' })
      if (result.status === 'ok') refresh()
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  // The Course ▸ Import Course menu item lands here. runImport is stable, so
  // this only ever fires on a fresh signal.
  useEffect(() => {
    if (importSignal > 0) void runImport()
  }, [importSignal, runImport])

  const saveSpec = async (): Promise<void> => {
    const { saved, error } = await window.opencourse.saveSpec()
    if (error) setNote({ text: error, error: true })
    else if (saved) setNote({ text: `Saved the course format to ${saved}.`, error: false })
  }

  const remove = async (course: CourseSummary): Promise<void> => {
    const ok = window.confirm(
      `Remove “${course.title}” from your library?\n\n` +
        `This permanently deletes all progress, chat history, exercise files and project folders for this course. ` +
        `Importing it again will start fresh.`
    )
    if (!ok) return
    try {
      await window.opencourse.removeCourse(course.courseId)
      refresh()
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    }
  }

  const empty = courses?.length === 0

  return (
    <>
      <TitleBar user={user} navigate={navigate} route={route} />
      <div className="body">
        <div className="content content-glass scroll">
          <div className="library">
            <div className="library-head">
              <div>
                <h1>Courses</h1>
                <div className="library-tabs" role="tablist" aria-label="Courses">
                  <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => navigate({ name: 'library', tab: 'mine' })}>My courses</button>
                  <button role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'on' : ''} onClick={() => navigate({ name: 'library', tab: 'catalog' })}>Course catalog</button>
                </div>
              </div>
              {tab === 'mine' && <div className="actions">
                <button disabled={busy} onClick={() => { void window.opencourse.createCourse().then(({ document }) => navigate({ name: 'courseEditor', courseId: document.courseId })).catch((err) => setNote({ text: err.message, error: true })) }}>Create course</button>
                <button disabled={busy} onClick={() => void runImport()}>
                  Import course
                </button>
                <button className="secondary" onClick={() => void saveSpec()}>
                  Get the course format
                </button>
              </div>}
            </div>

            {tab === 'catalog' ? <Catalog navigate={navigate} route={route} library={courses ?? []} onAdded={refresh} /> : <>

            {note && <p className={`import-note${note.error ? ' error' : ''}`}>{note.text}</p>}
            {courses === null && (note?.error ? <button className="secondary" onClick={refresh}>Retry loading library</button> : <p className="meta">Loading…</p>)}

            {empty && (
              <div className="empty-library">
                <h3>No courses yet</h3>
                <p>
                  OpenCourse doesn't ship any courses — you bring your own. Create a course here, import a <code>.zip</code> archive,
                  or add one from the <button className="ghost catalog-inline" onClick={() => navigate({ name: 'library', tab: 'catalog' })}>course catalog</button> of a server you connect to.
                </p>
                <p className="meta">
                  The format download includes the spec, the JSON Schema and an example course that imports
                  as-is.
                </p>
              </div>
            )}

            {courses?.map((course) =>
              course.error ? (
                <div key={course.courseId} className="course-card broken">
                  <div className="course-card-content">
                    <h3 title={course.title}>{course.title}</h3>
                    <p>This course could not be loaded: {course.error}</p>
                  </div>
                  <button className="ghost card-remove" onClick={() => void remove(course)}>
                    Remove
                  </button>
                </div>
              ) : (
                <div
                  key={course.courseId}
                  className="course-card"
                  onClick={() => navigate({ name: course.draft ? 'courseEditor' : 'course', courseId: course.courseId })}
                >
                  {course.coverUrl && <img src={course.coverUrl} alt="" />}
                  <div className="course-card-content">
                    <h3 title={course.title}>{course.title}{course.draft && <span className="tag">Draft</span>}</h3>
                    <div className="meta course-card-meta">
                      {course.subject ? `${course.subject} · ` : ''}
                      {course.difficulty ?? 'beginner'} · {course.lessonCount} lessons{course.projectCount ? ` · ${course.projectCount} projects` : ''}
                      {course.estimated_hours ? ` · ~${course.estimated_hours}h` : ''}
                      {course.author ? ` · ${course.author}` : ''}
                    </div>
                    <div className="course-card-origin">
                      <span className={`origin-badge${course.origin ? ' from-server' : ''}`} title={course.origin?.server}>{course.origin ? course.origin.serverName : 'Local'}</span>
                      {course.version && <span className="version-badge">v{course.version}</span>}
                      {(() => {
                        const label = updateLabel(updates[course.courseId])
                        return label && <span className={`update-badge ${label.tone}`}>{label.text}</span>
                      })()}
                    </div>
                    {course.recoveryNotice && <p className="import-note">{course.recoveryNotice}</p>}
                    {course.description && (
                      <Html as="p" inline source={course.description} />
                    )}
                    <div className="course-card-footer">
                      {course.progressPercent !== undefined && course.progressPercent > 0 && (
                        <div className="card-progress">
                          <div className="progress-bar">
                            <span style={{ width: `${course.progressPercent}%` }} />
                          </div>
                          <span className="meta">{course.progressPercent}%</span>
                        </div>
                      )}
                      <div className="course-card-tags">
                        {course.tags?.map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <button
                    className="ghost card-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(course)
                    }}
                  >
                    Remove
                  </button>
                </div>
              )
            )}
            </>}
          </div>
        </div>
      </div>
    </>
  )
}
