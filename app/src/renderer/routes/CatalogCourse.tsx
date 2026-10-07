import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CourseOverview } from '@core/catalog/api'
import type { UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import Html from '../components/Html'
import { useCatalogCover } from '../components/Catalog'
import type { Route, Screen } from '../routes'

/**
 * A server course before it is added: what it covers, how big it is, who
 * published it, its versions. Built from the server's overview, which has
 * titles and counts but never a question or an answer - nothing here can spoil
 * the course.
 */
export default function CatalogCourse({ serverId, courseId, user, navigate, route }: {
  serverId: string; courseId: string; user: UserProfile | null; navigate: (r: Route) => void; route: Screen
}): JSX.Element {
  const [course, setCourse] = useState<CourseOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inLibrary, setInLibrary] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void window.opencourse.getCatalogCourse(serverId, courseId).then((r) => { if (r.ok) setCourse(r.value); else setError(r.message) })
    void window.opencourse.listCourses().then((list) => setInLibrary(list.some((c) => c.courseId === courseId)))
  }, [serverId, courseId])
  useEffect(load, [load])
  useEffect(() => window.opencourse.onCoursesChanged(load), [load])
  const cover = useCatalogCover(serverId, course ?? { id: courseId, version: '0.0.0', hasCover: false })

  const add = async (): Promise<void> => {
    setBusy(true); setNote(null)
    try {
      const r = await window.opencourse.addCatalogCourse(serverId, courseId)
      if (r.ok) { setInLibrary(true); setNote({ text: `Added to your courses (v${r.value.version}).`, error: false }) }
      else setNote({ text: r.message, error: true })
    } finally { setBusy(false) }
  }

  const back = { label: 'Course catalog', onClick: () => navigate({ name: 'library', tab: 'catalog' }) }
  if (!course) {
    return <>
      <TitleBar user={user} navigate={navigate} route={route} back={back} />
      <div className="body"><div className="content scroll"><div className="detail">{error ? <p className="import-note error">{error}</p> : <p className="meta">Loading…</p>}</div></div></div>
    </>
  }

  const versions = course.versions.filter((v) => v.status !== 'deleted' && (course.ownedByYou || v.status !== 'withdrawn'))
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={back} />
    <div className="body">
      <div className="content scroll">
        <div className="detail catalog-detail">
          {cover && <img className="catalog-detail-cover" src={cover} alt="" />}
          <h1>{course.title}</h1>
          <div className="meta">
            {course.subject ? `${course.subject} · ` : ''}{course.difficulty ?? 'beginner'} · {course.lessonCount} lessons
            {course.projectCount ? ` · ${course.projectCount} projects` : ''}
            {course.estimatedHours ? ` · ~${course.estimatedHours}h` : course.totalMinutes ? ` · ~${Math.max(1, Math.round(course.totalMinutes / 60))}h` : ''}
            {course.author ? ` · ${course.author}` : ''}
          </div>
          <div className="course-card-origin catalog-detail-stats">
            <span className="version-badge">v{course.version}</span>
            <span className="meta">{course.downloads === 1 ? '1 download' : `${course.downloads} downloads`} · published by {course.publisher}{course.ownedByYou ? ' (you)' : ''} · updated {course.updatedAt.slice(0, 10)}</span>
            {!course.listed && <span className="update-badge muted">Unpublished</span>}
          </div>
          {course.tags.length > 0 && <div className="course-card-tags">{course.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>}

          <div className="actions catalog-detail-actions">
            {inLibrary
              ? <button onClick={() => navigate({ name: 'course', courseId })}>Open in my courses</button>
              : <button disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add to my courses'}</button>}
            {course.ownedByYou && <button className="secondary" onClick={() => navigate({ name: 'publication', serverId, courseId })}>Manage publication</button>}
          </div>
          {note && <p className={`import-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}

          {course.description && <Html className="prose" source={course.description} />}

          {course.prerequisites.length > 0 && (
            <div className="panel">
              <h2>Before you start</h2>
              <ul>{course.prerequisites.map((item, i) => <Html as="li" key={i} inline source={item} />)}</ul>
            </div>
          )}

          <div className="panel">
            <h2>Contents</h2>
            <p className="meta">
              {[`${course.lessonCount} lessons`, course.projectCount && `${course.projectCount} projects`, course.quizCount && `${course.quizCount} quizzes`, course.exerciseCount && `${course.exerciseCount} exercises`, course.flashcardCount && `${course.flashcardCount} flashcards`].filter(Boolean).join(' · ')}
            </p>
            {course.outline.map((mod, m) => (
              <div className="module-block" key={m}>
                <h3>{mod.title}</h3>
                {mod.kind === 'project'
                  ? <div className="lesson-row catalog-row"><span className="check">◇</span><span>Project</span></div>
                  : mod.lessons.map((lesson, l) => (
                    <div className="lesson-row catalog-row" key={l}>
                      <span className="num">{l + 1}</span><span>{lesson.title}</span>
                      {lesson.minutes && <span className="mins">{lesson.minutes} min</span>}
                    </div>
                  ))}
              </div>
            ))}
          </div>

          <div className="panel">
            <h2>Versions</h2>
            <ul className="catalog-versions">
              {versions.map((v) => (
                <li key={v.version}>
                  <strong>v{v.version}</strong>
                  {v.status === 'current' && <span className="version-badge">Current</span>}
                  {v.status === 'withdrawn' && <span className="update-badge muted">Withdrawn</span>}
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
