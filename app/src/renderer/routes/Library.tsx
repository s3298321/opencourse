import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CourseProgressStatus, CourseSummary, ImportResult, ServerConnection, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'
import Html from '../components/Html'
import CourseCardMedia from '../components/CourseCardMedia'
import CourseSourcePanel from '../components/CourseSourcePanel'
import type { UpdateState } from '@core/catalog/origin'
import { compareLibraryCourses, courseStatus } from '../library-courses'

const statusFilters: { id: CourseProgressStatus; label: string }[] = [
  { id: 'in-progress', label: 'In progress' },
  { id: 'not-started', label: 'Not started' },
  { id: 'completed', label: 'Completed' }
]

/** What a server course's card says about its version on the server. */
function updateLabel(state: UpdateState | undefined): { text: string; tone: 'update' | 'muted' } | null {
  switch (state?.kind) {
    case 'update': return { text: `Update to v${state.version}`, tone: 'update' }
    case 'switch': return { text: `Author rolled back to v${state.version}`, tone: 'update' }
    case 'unlisted': return { text: 'No longer published', tone: 'muted' }
    // The course works as it is; only whether it has an update is unknown.
    case 'disconnected': return { text: state.reason === 'not-connected' ? 'Server not connected' : 'Server unreachable', tone: 'muted' }
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
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  const requestedSource = route.name === 'library' ? route.source ?? 'local' : 'local'
  const [source, setSource] = useState(requestedSource)
  const [status, setStatus] = useState<CourseProgressStatus | null>(null)
  useEffect(() => setSource(requestedSource), [requestedSource])

  const refresh = useCallback(() => {
    void window.opencourse.listCourses().then((list) => {
      setCourses(list)
      // Only server courses have anything to ask a server about.
      if (list.some((c) => c.origin)) void window.opencourse.checkCourseUpdates().then(setUpdates).catch(() => {})
    }).catch((error) => setNote({ text: `The library could not be loaded. Your data is retained. ${error.message}`, error: true }))
  }, [])

  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onCoursesChanged(refresh), [refresh])

  const loadServers = useCallback(() => {
    void window.opencourse.listServers().then(setServers).catch((error) => {
      setNote({ text: `Course servers could not be loaded. ${error.message}`, error: true })
    })
  }, [])
  useEffect(loadServers, [loadServers])
  useEffect(() => window.opencourse.onServersChanged(loadServers), [loadServers])

  const connected = new Set(servers?.map((server) => server.url))
  const localCourses = courses?.filter((course) => !course.origin) ?? []
  const disconnectedCourses = courses?.filter((course) => course.origin && !connected.has(course.origin.server)) ?? []
  const sources: { id: string; name: string; courses: CourseSummary[]; url?: string }[] = [
    { id: 'local', name: 'Local', courses: localCourses },
    ...(servers ?? []).map((server) => ({ id: server.id, name: server.name, url: server.url, courses: courses?.filter((course) => course.origin?.server === server.url) ?? [] })),
    ...(servers !== null && disconnectedCourses.length ? [{ id: 'disconnected', name: 'Disconnected', courses: disconnectedCourses }] : [])
  ]
  const selectedSource = sources.find((item) => item.id === source) ?? sources[0]
  const selectedServer = servers?.find((server) => server.id === selectedSource.id)
  const visibleCourses = selectedSource.courses.filter((course) => status === null || courseStatus(course) === status).sort(compareLibraryCourses)
  useEffect(() => {
    // A removed connection should never leave the list on a missing tab.
    if (servers !== null && courses !== null && selectedSource.id !== source) setSource(selectedSource.id)
  }, [servers, courses, source, selectedSource.id])

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

  const empty = courses?.length === 0

  return (
    <>
      <TitleBar user={user} navigate={navigate} route={route} />
      <div className="body">
        <div className="content content-glass scroll courses-library">
          <div className="library">
            <div className="library-head">
              <div>
                <h1>Courses</h1>
              </div>
              <div className="actions">
                <ActionButton icon="plus" disabled={busy} onClick={() => { void window.opencourse.createCourse().then(({ document }) => navigate({ name: 'courseEditor', courseId: document.courseId })).catch((err) => setNote({ text: err.message, error: true })) }}>Create course</ActionButton>
                <ActionButton icon="upload" disabled={busy} onClick={() => void runImport()}>
                  Import course
                </ActionButton>
              </div>
            </div>

            <div className="course-source-bar">
            <div className="course-source-tabs" role="tablist" aria-label="Course source">
              {sources.map((item, index) => (
                <button key={item.id} id={`course-source-${index}`} role="tab" aria-selected={selectedSource.id === item.id}
                  aria-controls="course-source-panel" tabIndex={selectedSource.id === item.id ? 0 : -1}
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
                    setSource(sources[next].id)
                    document.getElementById(`course-source-${next}`)?.focus()
                  }}>
                  {item.name}<span className="course-source-count" aria-label={`${item.courses.length} ${item.courses.length === 1 ? 'course' : 'courses'}`}>{item.courses.length}</span>
                </button>
              ))}
            </div>
            </div>
            <CourseSourcePanel source={selectedSource.id} index={sources.indexOf(selectedSource)}>
            {note && <p className={`import-note${note.error ? ' error' : ''}`}>{note.text}</p>}
            {courses === null && (note?.error ? <ActionButton icon="refresh" className="secondary" onClick={refresh}>Retry loading library</ActionButton> : <p className="meta">Loading…</p>)}

            <div className="course-library-list">
              {selectedServer && <button className="add-courses" aria-label="Add courses" onClick={() => navigate({ name: 'catalog', serverId: selectedServer.id })}>
                <span className="add-courses-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg></span>
                <span className="add-courses-label" aria-hidden="true">Add courses</span>
              </button>}
              <div className="course-status-filters" role="group" aria-label="Filter courses by status">
                {statusFilters.map((filter) => (
                  <button key={filter.id} className="course-status-filter" aria-label={filter.label} aria-pressed={status === filter.id}
                    title={status === filter.id ? `${filter.label} · Click to show all courses` : filter.label}
                    disabled={courses === null} onClick={() => setStatus(status === filter.id ? null : filter.id)}>
                    <span className={`course-status-circle ${filter.id}`} aria-hidden="true">
                      {filter.id === 'completed' && <svg viewBox="0 0 16 16"><path d="m4 8 3 3 5-6" /></svg>}
                    </span>
                  </button>
                ))}
              </div>
              <div className="course-library-cards">
            {empty && selectedSource.id === 'local' && (
              <div className="empty-library">
                <h3>No courses yet</h3>
                <p>
                  Create a course, import a <code>.zip</code> archive, or select a server and choose Add courses.
                </p>
              </div>
            )}

            {courses !== null && (!empty || selectedSource.id !== 'local') && selectedSource.courses.length === 0 && (
              <div className="empty-library">
                <h3>{selectedSource.id === 'local' ? 'No local courses yet' : `No courses from ${selectedSource.name} yet`}</h3>
                <p>{selectedSource.id === 'local' ? 'Create a course or import a .zip archive to add a local course.' : 'Add a course from this server’s course catalog to see it here.'}</p>
              </div>
            )}

            {courses !== null && selectedSource.courses.length > 0 && visibleCourses.length === 0 && (
              <div className="empty-library">
                <h3>No {statusFilters.find((filter) => filter.id === status)?.label.toLowerCase()} courses</h3>
                <ActionButton icon="book" className="secondary" onClick={() => setStatus(null)}>Show all courses</ActionButton>
              </div>
            )}

            {visibleCourses.map((course) =>
              course.error ? (
                <div key={course.courseId} className="course-card broken">
                  <div className="course-card-content">
                    <h3 title={course.title}>{course.title}</h3>
                    <p>This course could not be loaded: {course.error}</p>
                  </div>
                </div>
              ) : (
                <div
                  key={course.courseId}
                  className="course-card"
                  onClick={() => navigate({ name: course.draft ? 'courseEditor' : 'course', courseId: course.courseId })}
                >
                  <CourseCardMedia coverUrl={course.coverUrl} tags={course.tags} />
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
                      <Html as="p" className="course-card-description" inline source={course.description} />
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
                    </div>
                  </div>
                </div>
              )
            )}
              </div>
            </div>
            </CourseSourcePanel>
          </div>
        </div>
      </div>
    </>
  )
}
