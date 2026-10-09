import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { runtimeLabel } from '@core/toolchains'
import { lessonKey } from '@core/manifest'
import { summarizeProgress } from '@core/progress'
import TitleBar from '../components/TitleBar'
import type { CourseProgress, CourseView, ReviewCount, ReviewSummary, UserProfile } from '@core/types'
import { reviewRecommendation } from '../review-display'
import { itemRoute, type Route, type Screen } from '../routes'
import Html from '../components/Html'
import CompletionMark from '../components/CompletionMark'
import CourseServerPanel from '../components/CourseServerPanel'

interface Props {
  courseId: string
  user: UserProfile | null
  navigate: (r: Route) => void
  route: Screen
}

export default function CourseDetail({ courseId, user, navigate, route }: Props): JSX.Element {
  const [course, setCourse] = useState<CourseView | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [progress, setProgress] = useState<CourseProgress | null>(null)
  const [review, setReview] = useState<ReviewSummary | null>(null)
  const [reviewCount, setReviewCount] = useState<ReviewCount>(10)
  const [reviewBusy, setReviewBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.opencourse.getCourse(courseId).then((course) => { if (alive) { setCourse(course); if (!course) navigate({ name: 'library' }) } })
      void window.opencourse.getProgress(courseId).then((p) => { if (alive) setProgress(p) })
      void window.opencourse.getReviewSummary(courseId).then((summary) => { if (alive) setReview(summary) }).catch((err) => { if (alive) setNote(err.message) })
    }
    refresh()
    const off = window.opencourse.onCoursesChanged(refresh)
    const offReview = window.opencourse.onReviewChanged((id) => { if (id === courseId) refresh() })
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    return () => { alive = false; off(); offReview(); window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [courseId])

  const summary = useMemo(
    () => (course && progress ? summarizeProgress(course, progress) : null),
    [course, progress]
  )

  if (!course || !progress) return <div className="empty">Loading…</div>

  const done = new Set(progress.completedLessons)
  const resume = course.flatItems.find((item) => item.moduleId === progress.lastItem?.moduleId && (item.kind === 'project' ? progress.lastItem.kind === 'project' : progress.lastItem.kind === 'lesson' && item.lessonId === progress.lastItem.lessonId)) ?? course.flatItems[0]

  return (
    <>
      <TitleBar
        user={user}
        navigate={navigate}
        route={route}
        back={{ label: 'All courses', onClick: () => navigate({ name: 'library' }) }}
      />
      <div className="body">
        <div className="content scroll">
          <div className="detail">
            <h1>{course.title}</h1>
            <div className="meta">
              {course.subject ? `${course.subject} · ` : ''}
              {course.difficulty ?? 'beginner'} · {course.flatLessons.length} lessons{course.flatItems.length > course.flatLessons.length ? ` · ${course.flatItems.length - course.flatLessons.length} projects` : ''}
              {course.totalMinutes ? ` · ~${Math.round(course.totalMinutes / 60)}h` : ''}
              {course.author ? ` · ${course.author}` : ''}
              {/* Only courses that actually carry exercises name a language. */}
              {runtimeLabel(course) ? ` · ${runtimeLabel(course)}` : ''}
            </div>

            {course.description && (
              <Html className="prose" source={course.description} />
            )}

            {note && <p role="status">{note}</p>}
            <CourseServerPanel course={course} navigate={navigate} actions={<>
              <button className="secondary" onClick={() => navigate({ name: 'courseEditor', courseId })}>Edit course</button>
              <button className="secondary" onClick={() => { void window.opencourse.exportCourse(courseId).then(({ saved }) => { if (saved) setNote(`Saved to ${saved}`) }).catch((err) => setNote(err.message)) }}>Export ZIP</button>
            </>} />
            <div className="summary">
              <button
                onClick={() =>
                  resume && navigate(itemRoute(course.courseId, resume))
                }
              >
                {progress.lastItem ? 'Continue' : 'Start course'}
              </button>
              <div className="course-review-control">
                <button className="secondary" disabled={reviewBusy || !review?.eligible} onClick={() => {
                  setReviewBusy(true); setNote(null)
                  void window.opencourse.startReviewSession(courseId, reviewCount).then(session => navigate({ name: 'review', session })).catch(err => setNote(err.message)).finally(() => setReviewBusy(false))
                }}>{reviewBusy ? 'Starting' : 'Review'}</button>
                <select aria-label="Number of flashcards" value={reviewCount} disabled={reviewBusy} onChange={event => setReviewCount(Number(event.target.value) as ReviewCount)}>
                  {[10, 15, 20].map(count => <option key={count} value={count}>{count} cards</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="progress-bar">
                  <span style={{ width: `${summary?.percent ?? 0}%` }} />
                </div>
                <div className="meta" style={{ marginTop: '0.35rem' }}>
                  {summary?.lessonsDone}/{summary?.lessonsTotal} lessons ·{' '}
                  {summary?.quizzesCorrect}/{summary?.quizzesTotal} quizzes ·{' '}
                  {summary?.exercisesDone}/{summary?.exercisesTotal} exercises
                  {summary?.projectsTotal ? ` · ${summary.projectsDone}/${summary.projectsTotal} projects` : ''}
                </div>
              </div>
            </div>

            {review && <div className="course-review-summary" role="status">
              <strong>{reviewRecommendation(review)}</strong>
              {!!review.eligible && <span className="meta">{review.due} due · {review.new} new · {review.practiced}/{review.eligible} practiced{review.estimatedRecall !== null ? ` · ${Math.round(review.estimatedRecall * 100)}% estimated recall` : ''}{review.eligible < review.total ? ` · ${review.total - review.eligible} locked` : ''}</span>}
            </div>}

            {course.prerequisites && course.prerequisites.length > 0 && (
              <div className="panel">
                <h2>Before you start</h2>
                <ul>
                  {course.prerequisites.map((item, i) => (
                    <Html as="li" key={i} inline source={item} />
                  ))}
                </ul>
              </div>
            )}

            <div className="panel">
              <h2>Contents</h2>
              {course.modules.map((mod) => (
                <div className="module-block" key={mod.slug}>
                  <h3>{mod.title}</h3>
                  {mod.type === 'project' ? (
                    <div className="lesson-row project-row" onClick={() => navigate({ name: 'project', courseId: course.courseId, moduleId: mod.slug })}>
                      <CompletionMark done={!!progress.projects?.[mod.slug]?.completedAt} project />
                      <span>Project · {mod.project.deliverables.length} deliverables</span>
                      {mod.project.estimated_minutes && <span className="mins">{mod.project.estimated_minutes} min</span>}
                    </div>
                  ) : mod.lessons.map((lesson) => {
                    const ref = course.flatLessons.find(
                      (l) => l.moduleId === mod.slug && l.lessonId === lesson.slug
                    )
                    return (
                      <div
                        className="lesson-row"
                        key={lesson.slug}
                        onClick={() =>
                          navigate({
                            name: 'lesson',
                            courseId: course.courseId,
                            moduleId: mod.slug,
                            lessonId: lesson.slug
                          })
                        }
                      >
                        <span className="num">{(ref?.index ?? 0) + 1}</span>
                        <CompletionMark done={done.has(lessonKey(mod.slug, lesson.slug))} />
                        <span>{lesson.title}</span>
                        {lesson.estimated_minutes && <span className="mins">{lesson.estimated_minutes} min</span>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
