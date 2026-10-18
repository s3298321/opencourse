import ActionButton, { Icon } from '../components/ActionButton'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ReviewAnswer, ReviewRating, ReviewSession } from '@core/types'
import type { Route } from '../routes'
import Html from '../components/Html'
import { ratingLabels } from '../review-display'

const ratings: ReviewRating[] = ['again', 'hard', 'good', 'easy']
export default function Review({ initialSession, navigate, active = true }: {
  initialSession: ReviewSession; navigate: (route: Route) => void; active?: boolean
}): JSX.Element {
  const [session, setSession] = useState(initialSession)
  const [answer, setAnswer] = useState<ReviewAnswer | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const working = useRef(false), mountedSession = useRef<string | null>(null)
  const primary = useRef<HTMLButtonElement>(null), answerHeading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const summaryHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const id = initialSession.id
    mountedSession.current = id
    return () => {
      mountedSession.current = null
      // StrictMode and Fast Refresh replay effects without leaving the screen.
      // Allow their setup to reclaim the session before ending it permanently.
      queueMicrotask(() => {
        if (mountedSession.current !== id) void window.opencourse.endReviewSession(id).catch(() => {})
      })
    }
  }, [initialSession.id])
  useEffect(() => {
    if (!active) return
    if (busy) return
    if (!session.card) summaryHeading.current?.focus()
    else if (answer) answerHeading.current?.focus()
    else {
      if (content.current) content.current.scrollTop = 0
      primary.current?.focus({ preventScroll: true })
    }
  }, [session.card?.id, answer, active, busy])
  const reveal = async (): Promise<void> => {
    if (working.current || !session.card || answer) return
    working.current = true; setBusy(true); setError('')
    try {
      const result = await window.opencourse.revealReviewAnswer(session.id, session.card.id)
      if (mountedSession.current === session.id) setAnswer(result)
    } catch (err) { if (mountedSession.current === session.id) setError((err as Error).message) }
    finally { working.current = false; if (mountedSession.current === session.id) setBusy(false) }
  }
  const rate = async (rating: ReviewRating): Promise<void> => {
    if (working.current || !session.card || !answer) return
    working.current = true; setBusy(true); setError('')
    try {
      const next = await window.opencourse.rateReviewCard(session.id, session.card.id, rating)
      if (mountedSession.current === session.id) { setSession(next); setAnswer(null) }
    } catch (err) { if (mountedSession.current === session.id) setError((err as Error).message) }
    finally { working.current = false; if (mountedSession.current === session.id) setBusy(false) }
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
    <header className="review-header"><div className="review-heading"><span className="review-emblem"><Icon name="review" /></span><div><span className="review-label">Flashcard review</span><strong>{session.courseTitle}</strong></div></div>
      <ActionButton icon={session.card ? 'close' : 'left'} className="secondary review-exit" disabled={busy} onClick={exit}>{session.card ? 'End review' : 'Back to course'}</ActionButton>
    </header>
    <div className="review-progress">
      <div className="review-progress-meta"><span role="status">{session.reviewed} / {session.total} reviewed</span></div>
      <div className="review-progress-track" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={session.total} aria-valuenow={session.reviewed}><span style={{ width: `${session.total ? session.reviewed / session.total * 100 : 0}%` }} /></div>
    </div>
    {error && <p className="error review-error" role="alert">{error} Your saved ratings are retained.</p>}
    <div className="review-content scroll" ref={content}>
      {session.card ? <article className={`review-card${answer ? ' is-revealed' : ''}`} key={session.card.id} aria-label={`Card ${session.reviewed + 1} of ${session.total}`}>
        <div className="review-card-meta"><span>{session.card.lessonTitle}</span><span className="review-card-number">Card {session.reviewed + 1} of {session.total}</span></div>
        <div className="review-question"><div className="review-question-label"><span className="review-label">Question</span>{session.card.early && <span className="review-early">Early review</span>}</div><Html className="prose" source={session.card.question} />
          {session.card.image && <img className="review-image" src={session.card.image.src} alt={session.card.image.alt ?? ''} />}
        </div>
        {answer && <div className="review-answer"><h2 className="review-label" ref={answerHeading} tabIndex={-1}>Answer</h2><Html className="prose" source={answer.answer} /></div>}
      </article> : <div className="review-complete">
        <div className="review-complete-icon"><Icon name="check" /></div>
        <h1 ref={summaryHeading} tabIndex={-1}>Review complete</h1>
        <div className="review-result-counts">{ratings.map(rating => <div className={`rating-${rating}`} key={rating}><strong>{session.ratings[rating]}</strong><span>{ratingLabels[rating]}</span></div>)}</div>
        <ActionButton icon="left" onClick={exit}>Back to course</ActionButton>
      </div>}
    </div>
    {session.card && <footer className="review-controls">
      {answer ? <div className="review-rating-panel">
        <div className="review-ratings">{ratings.map((rating, index) => <button key={rating} className={`secondary rating-${rating}`} disabled={busy} aria-label={ratingLabels[rating]} aria-keyshortcuts={String(index + 1)} onClick={() => void rate(rating)}>
          <strong><span className="review-rating-name"><span className="review-rating-dot" />{ratingLabels[rating]}</span><kbd>{index + 1}</kbd></strong>
        </button>)}</div>
      </div> : <div className="review-reveal"><ActionButton icon="eye" ref={primary} disabled={busy} aria-keyshortcuts="Space" onClick={() => void reveal()}><span>{busy ? 'Revealing…' : 'Reveal answer'}</span><kbd aria-hidden="true">Space</kbd></ActionButton></div>}
      <div className="review-shortcuts"><span><kbd>{answer ? '1–4' : 'Space'}</kbd> {answer ? 'to rate' : 'to reveal'}</span><span><kbd>Esc</kbd> to end review</span></div>
    </footer>}
  </section>
}
