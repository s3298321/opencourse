import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ReviewAnswer, ReviewRating, ReviewSession } from '@core/types'
import type { Route } from '../routes'
import Html from '../components/Html'
import { ratingDescriptions, ratingLabels, reviewRecommendation, reviewTime } from '../review-display'

const ratings: ReviewRating[] = ['again', 'hard', 'good', 'easy']
export default function Review({ initialSession, navigate, active = true }: {
  initialSession: ReviewSession; navigate: (route: Route) => void; active?: boolean
}): JSX.Element {
  const [session, setSession] = useState(initialSession)
  const [answer, setAnswer] = useState<ReviewAnswer | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const working = useRef(false), alive = useRef(true)
  const primary = useRef<HTMLButtonElement>(null), firstRating = useRef<HTMLButtonElement>(null)
  const summaryHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; void window.opencourse.endReviewSession(initialSession.id).catch(() => {}) }
  }, [initialSession.id])
  useEffect(() => {
    if (!active) return
    if (!session.card) summaryHeading.current?.focus()
    else if (answer) firstRating.current?.focus()
    else primary.current?.focus()
  }, [session.card?.id, answer, active, busy])
  const reveal = async (): Promise<void> => {
    if (working.current || !session.card || answer) return
    working.current = true; setBusy(true); setError('')
    try {
      const result = await window.opencourse.revealReviewAnswer(session.id, session.card.id)
      if (alive.current) setAnswer(result)
    } catch (err) { if (alive.current) setError((err as Error).message) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  const rate = async (rating: ReviewRating): Promise<void> => {
    if (working.current || !session.card || !answer) return
    working.current = true; setBusy(true); setError('')
    try {
      const next = await window.opencourse.rateReviewCard(session.id, session.card.id, rating)
      if (alive.current) { setSession(next); setAnswer(null) }
    } catch (err) { if (alive.current) setError((err as Error).message) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  const exit = (): void => {
    if (working.current) return
    navigate({ name: 'course', courseId: session.courseId })
  }
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent): void => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Escape') { event.preventDefault(); exit() }
      else if (event.code === 'Space' && session.card && !answer) { event.preventDefault(); void reveal() }
      else if (answer && ['1', '2', '3', '4'].includes(event.key)) { event.preventDefault(); void rate(ratings[Number(event.key) - 1]) }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [session, answer, active])
  return <section className="review-screen" aria-label="Flashcard review" aria-busy={busy}>
    <header className="review-header"><div><span className="meta">Flashcard review</span><strong>{session.courseTitle}</strong></div>
      <button className="ghost" disabled={busy} onClick={exit}>{session.card ? 'End review' : 'Back to course'}</button>
    </header>
    <div className="review-content scroll">
      {error && <p className="error review-error" role="alert">{error} Your saved ratings are retained.</p>}
      {session.card ? <div className="review-card" key={session.card.id}>
        <div className="review-card-meta meta"><span>{session.card.lessonTitle}</span><span>Card {session.reviewed + 1} of {session.total}{session.card.early ? ' · Early review' : ''}</span></div>
        <div className="progress-bar" aria-label="Review progress"><span style={{ width: `${session.reviewed / session.total * 100}%` }} /></div>
        <div className="review-question"><span className="review-label">Question</span><Html className="prose" source={session.card.question} />
          {session.card.image && <img className="review-image" src={session.card.image.src} alt={session.card.image.alt ?? ''} />}
        </div>
        {answer ? <>
          <div className="review-answer"><span className="review-label">Answer</span><Html className="prose" source={answer.answer} /></div>
          <p className="meta review-help">How well did you recall it? Choose Again if you forgot; Hard means you recalled it with difficulty.</p>
          <div className="review-ratings">{ratings.map((rating, index) => <button ref={index === 0 ? firstRating : undefined} key={rating} className={`secondary rating-${rating}`} disabled={busy} onClick={() => void rate(rating)}>
            <strong>{ratingLabels[rating]} <kbd>{index + 1}</kbd></strong><span>{ratingDescriptions[rating]}</span><small>{reviewTime(answer.intervals[rating])}</small>
          </button>)}</div>
        </> : <div className="review-reveal"><button ref={primary} disabled={busy} onClick={() => void reveal()}>{busy ? 'Revealing…' : 'Reveal answer'}</button><span className="meta">Think of your answer first · Space to reveal</span></div>}
      </div> : <div className="review-complete">
        <span className="review-label">Session complete</span><h1 ref={summaryHeading} tabIndex={-1}>Review complete</h1><p>You reviewed {session.reviewed} {session.reviewed === 1 ? 'card' : 'cards'}.</p>
        <div className="review-result-counts">{ratings.map(rating => <div key={rating}><strong>{session.ratings[rating]}</strong><span>{ratingLabels[rating]}</span></div>)}</div>
        <p role="status">{reviewRecommendation(session.summary)}</p><button onClick={exit}>Back to course</button>
      </div>}
    </div>
  </section>
}
