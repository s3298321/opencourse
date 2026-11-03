import { useCallback, useEffect, useState } from 'react'
import type { FlashcardProposal, ReviewTarget } from '@core/personal-cards'
import type { ReviewCount, ReviewSummary } from '@core/types'
import { FlashcardPreview, PersonalCardManager } from '../../learning-ui/PersonalCards'
import type { Route, Screen } from '../routes'
import Html from './Html'
import ActionButton from './ActionButton'

export function LocalFlashcardPreviews({ chatId }: { chatId: string }) {
  const [proposals,setProposals] = useState<FlashcardProposal[]>([])
  useEffect(() => {
    if (!window.opencourse?.listFlashcardProposals) return
    let alive=true
    const refresh=() => { void window.opencourse.listFlashcardProposals(chatId).then(p => { if (alive) setProposals(p) }).catch(() => {}) }
    refresh()
    const unsubscribe=window.opencourse.onPersonalCardsChanged(refresh)
    window.addEventListener('focus',refresh)
    return () => { alive=false;unsubscribe();window.removeEventListener('focus',refresh) }
  },[chatId])
  return <>{proposals.map(p => <FlashcardPreview key={p.id} proposal={p} decide={window.opencourse.decideFlashcardProposal} renderText={text => <Html className="prose" source={text} />} />)}</>
}
export function LocalPersonalCardManager({ target,count }: { target: ReviewTarget; count: number }) {
  return <PersonalCardManager count={count} load={() => window.opencourse.listPersonalCards(target)} remove={id => window.opencourse.deletePersonalCard(target,id)} />
}
export function DocumentReviewControls({ documentId,navigate,from }: { documentId:string; navigate:(route:Route)=>void; from:Screen }) {
  const [summary,setSummary]=useState<ReviewSummary | null>(null),[count,setCount]=useState<ReviewCount>(10),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const refresh=useCallback(() => { void window.opencourse.getReviewSummary?.({kind:'document',id:documentId}).then(setSummary).catch(() => {}) },[documentId])
  useEffect(() => {
    refresh()
    const off=window.opencourse.onPersonalCardsChanged?.(refresh),offReview=window.opencourse.onReviewChanged?.(refresh)
    window.addEventListener('focus',refresh)
    return () => { off?.();offReview?.();window.removeEventListener('focus',refresh) }
  },[refresh])
  if (!summary?.personalCount) return null
  return <div className="document-review-controls">
    <ActionButton icon="review" className="secondary" disabled={busy} onClick={() => { setBusy(true);setError('');void window.opencourse.startReviewSession({kind:'document',id:documentId},count).then(session => navigate({name:'review',session,from})).catch(e => setError(e.message)).finally(() => setBusy(false)) }}>Review</ActionButton>
    <select aria-label="Number of flashcards" value={count} onChange={e => setCount(Number(e.target.value) as ReviewCount)}>{[10,15,20].map(n => <option key={n} value={n}>{n} cards</option>)}</select>
    <LocalPersonalCardManager target={{kind:'document',id:documentId}} count={summary.personalCount} />
    <span>{summary.due} due · {summary.new} new</span>{error && <span role="alert">{error}</span>}
  </div>
}
