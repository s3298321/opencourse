import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FlashcardProposal } from '../core/personal-cards'
import './personal-cards.css'

export function FlashcardPreview({ proposal, decide, renderText = text => text }: {
  proposal: FlashcardProposal
  decide: (id: string, action: 'save' | 'dismiss') => Promise<FlashcardProposal>
  renderText?: (text: string) => ReactNode
}) {
  const [current, setCurrent] = useState(proposal), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const working = useRef(false)
  useEffect(() => setCurrent(proposal),[proposal])
  const act = async (action: 'save' | 'dismiss') => {
    if (working.current) return
    working.current=true; setBusy(true); setError('')
    try { setCurrent(await decide(current.id,action)); window.dispatchEvent(new Event('personal-cards-changed')) }
    catch (e) { setError((e as Error).message) }
    finally { working.current=false; setBusy(false) }
  }
  return <section className="personal-card-preview" aria-label="Flashcard preview">
    <strong>Personal flashcards · {current.title}</strong>
    <ol>{current.cards.map(c => <li key={c.id}><div className="personal-card-question">{renderText(c.question)}</div><div>{renderText(c.answer)}</div></li>)}</ol>
    {current.status === 'pending' ? <div className="personal-card-actions"><button disabled={busy} onClick={() => void act('save')}>{busy ? 'Working…' : 'Save all'}</button><button disabled={busy} onClick={() => void act('dismiss')}>Dismiss</button></div>
      : <p role="status">{current.status === 'saved' ? `${current.cards.length} ${current.cards.length === 1 ? 'card' : 'cards'} saved` : 'Preview dismissed'}</p>}
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
  return <><button className="personal-card-count" onClick={() => setOpen(true)}>{count} personal</button>
    {open && <dialog className="personal-card-dialog" ref={dialog} aria-label="Personal flashcards" onClose={() => setOpen(false)}>
      <div className="personal-card-actions"><h2>Personal flashcards</h2><button aria-label="Close personal flashcards" onClick={() => dialog.current?.close()}>✕</button></div>
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">Loading…</p> : cards.length ? <ul>{cards.map(c => <li key={c.id}><span>{c.question}</span><button disabled={busy !== null} aria-label={`Delete card: ${c.question}`} onClick={() => void erase(c.id)}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
      </button></li>)}</ul> : <p>No personal flashcards yet. Ask the chat to create some.</p>}
    </dialog>}
  </>
}
