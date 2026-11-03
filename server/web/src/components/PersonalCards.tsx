import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ReviewTarget } from '@core/personal-cards'
import type { LearningState } from '@core/learning/types'
import { PersonalCardManager } from '../../../../app/src/learning-ui/PersonalCards'
import { call } from '../lib/api'

export function WebPersonalCardManager({target,count}:{target:ReviewTarget;count:number}) {
  const base=`/me/learning/${target.kind}/${encodeURIComponent(target.id)}/personal-cards`
  return <PersonalCardManager count={count} load={async () => {
    const cards:{id:string;question:string}[]=[]
    let cursor:string|null=''
    while(cursor!==null) {
      const page:{cards:{id:string;question:string;deleted:boolean}[];nextCursor:string|null}=await call('GET',`${base}?after=${cursor}`)
      cards.push(...page.cards.filter(c => !c.deleted));cursor=page.nextCursor
    }
    return cards
  }} remove={id => call('DELETE',`${base}/${encodeURIComponent(id)}`)} />
}
export function WebDocumentReviewControls({id,from='reader'}:{id:string;from?:'reader'|'overview'}) {
  const [state,setState]=useState<LearningState|null>(null),[count,setCount]=useState(10)
  useEffect(() => {
    let alive=true
    const refresh=() => { void call<{items:LearningState[]}>('GET','/me/learning').then(r => { if(alive) setState(r.items.find(s => s.enrollment.kind==='document' && s.enrollment.id===id && s.enrollment.active) ?? null) }).catch(() => {}) }
    refresh()
    const timer=setInterval(refresh,30000)
    window.addEventListener('focus',refresh);window.addEventListener('personal-cards-changed',refresh)
    return () => {alive=false;clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('personal-cards-changed',refresh)}
  },[id])
  const total=state?.personalCards?.length ?? 0
  if(!total) return null
  return <div className="document-review-controls"><Link className="oc-btn secondary" to={`/learning/documents/${encodeURIComponent(id)}/review?cards=${count}&from=${from}`}>Review</Link>
    <select aria-label="Number of flashcards" value={count} onChange={e => setCount(Number(e.target.value))}>{[10,15,20].map(n => <option key={n} value={n}>{n} cards</option>)}</select>
    <WebPersonalCardManager target={{kind:'document',id}} count={total} />
  </div>
}
