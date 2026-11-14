import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FlashcardProposal } from '../core/personal-cards'
import { useDialogBackdropClose } from './useDialogBackdropClose'
import './personal-cards.css'

export function FlashcardPreview({ proposal, decide, renderText = text => text }: {
  proposal: FlashcardProposal
  decide: (id: string, action: 'save' | 'dismiss', cardId: string) => Promise<FlashcardProposal>
  renderText?: (text: string) => ReactNode
}) {
  const [current, setCurrent] = useState(proposal), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [leaving,setLeaving] = useState<{ action: 'save' | 'dismiss'; result: FlashcardProposal } | null>(null)
  const working = useRef(false)
  useEffect(() => { if (!working.current) setCurrent(proposal) },[proposal])
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => {
      setCurrent(leaving.result); setLeaving(null); setBusy(false); working.current=false
    },window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 280)
    return () => window.clearTimeout(timer)
  },[leaving])
  const pending = current.status === 'pending' ? current.cards.filter(card => !card.decision) : []
  const card = pending[0]
  const saved = current.cards.filter(card => card.decision === 'saved' || (!card.decision && current.status === 'saved')).length
  const rejected = current.cards.filter(card => card.decision === 'dismissed' || (!card.decision && current.status === 'dismissed')).length
  const act = async (action: 'save' | 'dismiss') => {
    if (working.current || !card) return
    working.current=true; setBusy(true); setError('')
    try {
      const result = await decide(current.id,action,card.id)
      setLeaving({action,result})
      window.dispatchEvent(new Event('personal-cards-changed'))
    } catch (e) {
      setError((e as Error).message); setBusy(false); working.current=false
    }
  }
  return <section className="personal-card-preview" aria-label="Flashcard preview">
    <header className="personal-card-heading"><strong>Personal flashcards</strong><span>{current.title}</span></header>
    {card ? <>
      <div className="personal-card-progress" role="status">Card {current.cards.length - pending.length + 1} of {current.cards.length}{saved > 0 && ` · ${saved} saved`}</div>
      <div className="personal-card-stack" data-depth={Math.min(pending.length,3)}>
        {pending.length > 2 && <div className="personal-card-under personal-card-under-back" aria-hidden="true" />}
        {pending.length > 1 && <div className="personal-card-under" aria-hidden="true" />}
        <article key={card.id} className={`personal-card-front${leaving ? ` personal-card-leave-${leaving.action}` : ''}`} aria-label={`Card ${current.cards.length - pending.length + 1}`}>
          <div className="personal-card-question">{renderText(card.question)}</div>
          <div className="personal-card-answer">{renderText(card.answer)}</div>
        </article>
      </div>
      <div className="personal-card-actions personal-card-decisions">
        <button disabled={busy} onClick={() => void act('dismiss')}><span aria-hidden="true">←</span> Reject</button>
        <button className="personal-card-add" disabled={busy} onClick={() => void act('save')}>Add <span aria-hidden="true">→</span></button>
      </div>
    </> : <p className="personal-card-summary" role="status">{saved} {saved === 1 ? 'card' : 'cards'} saved{rejected > 0 && ` · ${rejected} rejected`}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
export function PersonalCardManager({ count, load, remove }: {
  count: number
  load: () => Promise<{ id: string; question: string }[]>
  remove: (id: string) => Promise<void>
}) {
  const [open,setOpen] = useState(false), [cards,setCards] = useState<{id:string;question:string}[]>([])
  const [busy,setBusy] = useState<string | null>(null), [error,setError] = useState(''), [loading,setLoading] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), removeLock = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const backdrop = useDialogBackdropClose(() => dialog.current?.close())
  useEffect(() => {
    if (!open) return
    let alive=true
    setError('');setLoading(true)
    void load().then(c => { if (alive) setCards(c) }).catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) })
    dialog.current?.showModal()
    return () => { alive=false }
  },[open,count])
  const erase = async (id:string) => {
    if (removeLock.current) return
    removeLock.current=true;setBusy(id);setError('')
    try { await remove(id); setCards(list => list.filter(c => c.id!==id)); window.dispatchEvent(new Event('personal-cards-changed')) }
    catch (e) { setError((e as Error).message) }
    finally { removeLock.current=false;setBusy(null) }
  }
  return <><button ref={trigger} className="personal-card-count" onClick={() => setOpen(true)}>{count} personal</button>
    {open && <dialog className="personal-card-dialog" ref={dialog} aria-label="Personal flashcards" onClose={() => { setOpen(false); trigger.current?.focus() }} {...backdrop}>
      <div className="personal-card-actions"><h2>Personal flashcards</h2><button aria-label="Close personal flashcards" onClick={() => dialog.current?.close()}>✕</button></div>
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">Loading…</p> : cards.length ? <ul>{cards.map(c => <li key={c.id}><span>{c.question}</span><button disabled={busy !== null} aria-label={`Delete card: ${c.question}`} onClick={() => void erase(c.id)}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
      </button></li>)}</ul> : <p>No personal flashcards yet. Ask the chat to create some.</p>}
    </dialog>}
  </>
}
