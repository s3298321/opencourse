/**
 * A course in My learning: the app's course overview (CourseDetail) and its
 * flashcard review session (Review), over the synced learning state. Lessons
 * hold no flashcards on either side - review is a session started from here.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Check, Eye, Layers, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { CourseView, ReviewCount, ReviewRating } from '@core/types'
import type { LearningState } from '@core/learning/types'
import { reviewQueue } from '@core/review'
import { runtimeLabel } from '@core/toolchains'
import { ratingLabels, reviewRecommendation } from '../../../../app/src/learning-ui/review-display'
import { call } from '../lib/api'
import { courseSummary, lessonDone, loadEnrolledCourse, resumeIndex, reviewCandidates, reviewSummary, type EnrolledCourse, type WebReviewCard } from '../lib/learning'
import { renderInline, renderMarkdown } from '../lib/markdown'
import { Html } from '../components/Html'
import { useTitle } from '../components/Bits'

const COUNTS: ReviewCount[] = [10, 15, 20]
const RATINGS: ReviewRating[] = ['again', 'hard', 'good', 'easy']
const enc = encodeURIComponent

/** The reader's address for one item of the course. */
export function itemHref(courseId: string, item: CourseView['flatItems'][number]): string {
  const query = item.kind === 'project' ? `module=${enc(item.moduleId)}` : `module=${enc(item.moduleId)}&lesson=${enc(item.lessonId)}`
  return `/learn/course/${enc(courseId)}?${query}`
}

function useEnrolledCourse(id: string) {
  const [data, setData] = useState<EnrolledCourse | null>(null), [error, setError] = useState('')
  const load = useCallback(() => loadEnrolledCourse(id).then((d) => { setData(d); setError('') }).catch((e: Error) => setError(e.message)), [id])
  return { data, error, setError, load }
}

export function LearningCoursePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { data, error, setError, load } = useEnrolledCourse(id)
  const [count, setCount] = useState<ReviewCount>(10)
  const [busy, setBusy] = useState(false)
  useTitle(data?.course.title ?? 'Course')
  useEffect(() => {
    void load()
    // Another device may have read, rated or reviewed in the meantime.
    const refresh = () => void load()
    const timer = setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [load])

  if (!data) {
    return (
      <div className="oc-wrap page learning-course">
        <Link className="back-link" to="/learning"><ArrowLeft aria-hidden /> My learning</Link>
        {error ? <p className="form-error" role="alert">{error}</p> : <div className="oc-skeleton learning-course-skeleton" role="status" aria-label="Loading course" />}
      </div>
    )
  }

  const { course, state, update } = data
  const summary = courseSummary(course, state)
  const review = reviewSummary(course, state)
  const resume = course.flatItems[resumeIndex(course, state)]
  const started = Boolean(state.fields.lastItem)
  const projects = course.flatItems.length - course.flatLessons.length
  const runtime = runtimeLabel(course)

  const updateCourse = () => {
    if (!update || !confirm(`Update to ${update}? Course progress follows existing lessons.`)) return
    setBusy(true)
    void call('PUT', `/me/learning/course/${enc(id)}`, { version: update }).then(load).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const remove = () => {
    if (!confirm('Remove from My learning on all devices? Progress and chats are retained.')) return
    setBusy(true)
    void call('DELETE', `/me/learning/course/${enc(id)}`).then(() => navigate('/learning')).catch((e: Error) => { setError(e.message); setBusy(false) })
  }

  return (
    <div className="oc-wrap page learning-course">
      <Link className="back-link" to="/learning"><ArrowLeft aria-hidden /> My learning</Link>
      <div className="learning-course-actions">
        {update && <button className="oc-btn secondary sm" disabled={busy} onClick={updateCourse}><RefreshCw aria-hidden /> Update to {update}</button>}
        <button className="oc-btn ghost sm" disabled={busy} onClick={remove}><Trash2 aria-hidden /> Remove from My learning</button>
      </div>
      <h1>{course.title}</h1>
      <p className="learning-course-meta">
        {course.subject ? `${course.subject} · ` : ''}
        {course.difficulty ?? 'beginner'} · {course.flatLessons.length} lessons{projects > 0 ? ` · ${projects} projects` : ''}
        {course.totalMinutes ? ` · ~${Math.round(course.totalMinutes / 60)}h` : ''}
        {course.author ? ` · ${course.author}` : ''}
        {runtime ? ` · ${runtime}` : ''}
      </p>
      {course.description && <Html className="oc-prose learning-course-description" html={renderMarkdown(course.description)} />}
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="learning-course-summary" aria-label="Progress">
        <div>
          <div className="learning-progress-bar"><span style={{ width: `${summary.percent}%` }} /></div>
          <p className="learning-course-meta">
            {summary.lessonsDone}/{summary.lessonsTotal} lessons · {summary.quizzesCorrect}/{summary.quizzesTotal} quizzes · {summary.exercisesDone}/{summary.exercisesTotal} exercises
            {summary.projectsTotal ? ` · ${summary.projectsDone}/${summary.projectsTotal} projects` : ''}
          </p>
        </div>
        {resume && <Link className="oc-btn learning-course-continue" to={itemHref(id, resume)}><Play aria-hidden />{started ? 'Continue' : 'Start course'}</Link>}
        <div className="learning-review-row">
          <div className="learning-review-control">
            <button className="oc-btn secondary" disabled={!review.eligible}
              onClick={() => navigate(`/learning/courses/${enc(id)}/review?cards=${count}`)}>
              <Layers aria-hidden /> Review
            </button>
            <select aria-label="Number of flashcards" value={count} onChange={(e) => setCount(Number(e.target.value) as ReviewCount)}>
              {COUNTS.map((n) => <option key={n} value={n}>{n} cards</option>)}
            </select>
          </div>
          <strong className={`learning-review-summary${review.total === 0 ? ' no-flashcards' : ''}`} role="status">{reviewRecommendation(review)}</strong>
          {review.eligible > 0 && (
            <span className="learning-course-meta learning-review-counts">
              {review.due} due · {review.new} new · {review.practiced}/{review.eligible} practiced
              {review.estimatedRecall !== null ? ` · ${Math.round(review.estimatedRecall * 100)}% estimated recall` : ''}
              {review.eligible < review.total ? ` · ${review.total - review.eligible} locked` : ''}
            </span>
          )}
        </div>
      </section>

      {course.prerequisites && course.prerequisites.length > 0 && (
        <section className="oc-panel learning-course-panel">
          <h2>Before you start</h2>
          <ul>{course.prerequisites.map((p, i) => <Html as="li" key={i} html={renderInline(p)} />)}</ul>
        </section>
      )}

      <section className="oc-panel learning-course-panel">
        <h2>Contents</h2>
        {course.modules.map((module) => (
          <div className="learning-module" key={module.slug}>
            <h3>{module.title}</h3>
            {module.type === 'project' ? (
              <Link className="learning-lesson-row" to={itemHref(id, { kind: 'project', moduleId: module.slug } as CourseView['flatItems'][number])}>
                <Completion done={Boolean((state.fields[`project:${module.slug}`]?.value as { completedAt?: string } | null)?.completedAt)} project />
                <span>Project · {module.project.deliverables.length} deliverables</span>
                {module.project.estimated_minutes && <span className="learning-lesson-mins">{module.project.estimated_minutes} min</span>}
              </Link>
            ) : module.lessons.map((lesson) => {
              const ref = course.flatLessons.find((l) => l.moduleId === module.slug && l.lessonId === lesson.slug)
              return (
                <Link className="learning-lesson-row" data-lesson-id={lesson.slug} key={lesson.slug}
                  to={itemHref(id, { kind: 'lesson', moduleId: module.slug, lessonId: lesson.slug } as CourseView['flatItems'][number])}>
                  <span className="learning-lesson-num">{(ref?.index ?? 0) + 1}</span>
                  <Completion done={lessonDone(state, lesson.slug)} />
                  <span>{lesson.title}</span>
                  {lesson.estimated_minutes && <span className="learning-lesson-mins">{lesson.estimated_minutes} min</span>}
                </Link>
              )
            })}
          </div>
        ))}
      </section>
    </div>
  )
}

function Completion({ done, project }: { done: boolean; project?: boolean }) {
  return (
    <span className={`learning-completion${done ? ' done' : ''}${project ? ' project' : ''}`} role="img" aria-label={done ? 'Completed' : 'Not completed'}>
      {done && <Check aria-hidden />}
    </span>
  )
}

interface Session {
  version: string
  title: string
  cards: WebReviewCard[]
  index: number
  ratings: Record<ReviewRating, number>
}

/**
 * The queue is fixed when the session starts, as in the app: the due cards
 * first, then unseen ones, or the next due cards for early review when caught
 * up, up to the count chosen on the overview. Every
 * reveal and rating is the server's, so the answer never reaches the page
 * before it is asked for and a rating is the same FSRS step on every device.
 */
export function ReviewPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const count = (COUNTS as number[]).includes(Number(params.get('cards'))) ? Number(params.get('cards')) : 10
  const [session, setSession] = useState<Session | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [startError, setStartError] = useState('')
  const working = useRef(false)
  const receipts = useRef(new Map<string, string>())
  const primary = useRef<HTMLButtonElement>(null), answerHeading = useRef<HTMLHeadingElement>(null), summaryHeading = useRef<HTMLHeadingElement>(null)
  useTitle(session ? `Review · ${session.title}` : 'Flashcard review')

  useEffect(() => {
    let alive = true
    void loadEnrolledCourse(id).then(({ course, state }: { course: CourseView; state: LearningState }) => {
      if (!alive) return
      const all = reviewCandidates(course, state), queue = reviewQueue(all, count, new Date())
      if (!queue.length) {
        setStartError('Complete a lesson with flashcards to unlock review.')
        return
      }
      setSession({ version: state.enrollment.version, title: course.title, cards: queue.map((cardId) => all.find((c) => c.id === cardId)!),
        index: 0, ratings: { again: 0, hard: 0, good: 0, easy: 0 } })
    }).catch((e: Error) => { if (alive) setStartError(e.message) })
    return () => { alive = false }
  }, [id, count])

  const card = session?.cards[session.index] ?? null
  const base = session ? `/learn/course/${enc(id)}/${enc(session.version)}/cards` : ''
  const exit = () => { if (!working.current) navigate(`/learning/courses/${enc(id)}`) }

  useEffect(() => {
    if (busy || !session) return
    if (!card) summaryHeading.current?.focus()
    else if (answer !== null) answerHeading.current?.focus()
    else primary.current?.focus({ preventScroll: true })
  }, [card?.id, answer, busy, session])

  const reveal = async () => {
    if (working.current || !card || answer !== null) return
    working.current = true; setBusy(true); setError('')
    try { setAnswer((await call<{ answer: string }>('POST', `${base}/${enc(card.id)}/reveal`, {})).answer) }
    catch (e) { setError((e as Error).message) }
    finally { working.current = false; setBusy(false) }
  }
  const rate = async (rating: ReviewRating) => {
    if (working.current || !card || answer === null) return
    working.current = true; setBusy(true); setError('')
    // One request id per card, so a retry after a dropped response is the same rating, not a second one.
    let requestId = receipts.current.get(card.id)
    if (!requestId) { requestId = crypto.randomUUID(); receipts.current.set(card.id, requestId) }
    try {
      await call('POST', `${base}/${enc(card.id)}/rate`, { rating, requestId })
      setSession((s) => s && { ...s, index: s.index + 1, ratings: { ...s.ratings, [rating]: s.ratings[rating] + 1 } })
      setAnswer(null)
    } catch (e) { setError((e as Error).message) }
    finally { working.current = false; setBusy(false) }
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (event.key === 'Escape') { event.preventDefault(); exit() }
      else if (event.code === 'Space' && card && answer === null) { event.preventDefault(); void reveal() }
      else if (answer !== null && ['1', '2', '3', '4'].includes(event.key)) { event.preventDefault(); void rate(RATINGS[Number(event.key) - 1]!) }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  if (!session) {
    return (
      <div className="oc-wrap page review-page">
        <Link className="back-link" to={`/learning/courses/${enc(id)}`}><ArrowLeft aria-hidden /> Back to course</Link>
        {startError ? <p className="form-error" role="alert">{startError}</p> : <div className="oc-skeleton review-card-skeleton" role="status" aria-label="Starting review" />}
      </div>
    )
  }

  const total = session.cards.length
  return (
    <section className="oc-wrap page review-page" aria-label="Flashcard review" aria-busy={busy}>
      <header className="review-header">
        <div className="review-heading">
          <span className="review-emblem"><Layers aria-hidden /></span>
          <div><span className="review-label">Flashcard review</span><strong>{session.title}</strong></div>
        </div>
        <button className="oc-btn secondary sm" disabled={busy} onClick={exit}>
          {card ? <><X aria-hidden /> End review</> : <><ArrowLeft aria-hidden /> Back to course</>}
        </button>
      </header>
      <div className="review-progress">
        <div className="review-progress-meta"><span role="status">{session.index} / {total} reviewed</span></div>
        <div className="review-progress-track" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={session.index}>
          <span style={{ width: `${total ? (session.index / total) * 100 : 0}%` }} />
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error} Your saved ratings are retained.</p>}
      {card ? (
        <article className={`review-card${answer !== null ? ' is-revealed' : ''}`} key={card.id} aria-label={`Card ${session.index + 1} of ${total}`}>
          <div className="review-card-meta"><span>{card.lessonTitle}</span><span className="review-card-number">Card {session.index + 1} of {total}</span></div>
          <div className="review-question">
            <div className="review-question-label">
              <span className="review-label">Question</span>
              {card.state && card.state.due > new Date() && <span className="review-early">Early review</span>}
            </div>
            <Html className="oc-prose" html={renderMarkdown(card.card.question)} />
            {card.card.image && <img className="review-image" src={card.card.image.src} alt={card.card.image.alt ?? ''} />}
          </div>
          {answer !== null && (
            <div className="review-answer">
              <h2 className="review-label" ref={answerHeading} tabIndex={-1}>Answer</h2>
              <Html className="oc-prose" html={renderMarkdown(answer)} />
            </div>
          )}
        </article>
      ) : (
        <div className="review-complete">
          <div className="review-complete-icon"><Check aria-hidden /></div>
          <h1 ref={summaryHeading} tabIndex={-1}>Review complete</h1>
          <div className="review-result-counts">
            {RATINGS.map((rating) => <div className={`rating-${rating}`} key={rating}><strong>{session.ratings[rating]}</strong><span>{ratingLabels[rating]}</span></div>)}
          </div>
          <button className="oc-btn" onClick={exit}><ArrowLeft aria-hidden /> Back to course</button>
        </div>
      )}
      {card && (
        <footer className="review-controls">
          {answer !== null ? (
            <div className="review-ratings">
              {RATINGS.map((rating, index) => (
                <button key={rating} className={`review-rating rating-${rating}`} disabled={busy} aria-label={ratingLabels[rating]} aria-keyshortcuts={String(index + 1)} onClick={() => void rate(rating)}>
                  <span className="review-rating-name"><span className="review-rating-dot" />{ratingLabels[rating]}</span><kbd className="oc-kbd">{index + 1}</kbd>
                </button>
              ))}
            </div>
          ) : (
            <div className="review-reveal">
              <button className="oc-btn" ref={primary} disabled={busy} aria-keyshortcuts="Space" onClick={() => void reveal()}>
                <Eye aria-hidden /> {busy ? 'Revealing…' : 'Reveal answer'} <kbd className="oc-kbd" aria-hidden="true">Space</kbd>
              </button>
            </div>
          )}
          <div className="review-shortcuts">
            <span><kbd className="oc-kbd">{answer !== null ? '1–4' : 'Space'}</kbd> {answer !== null ? 'to rate' : 'to reveal'}</span>
            <span><kbd className="oc-kbd">Esc</kbd> to end review</span>
          </div>
        </footer>
      )}
    </section>
  )
}
