import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function DeleteCoachDialog({ name, onDelete, onClose }: {
  name: string; onDelete: () => Promise<void>; onClose: () => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), cancel = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const remove = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onDelete(); onClose() }
    catch (cause) { setError((cause as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  return createPortal(<div className="dialog-backdrop writing-dialog-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget && !pending.current) { event.preventDefault(); onClose() }
  }}><div ref={dialog} className="dialog writing-title-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-coach-title" aria-describedby="delete-coach-detail" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!pending.current) onClose() }
    if (event.key === 'Tab') {
      const items = [...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], first = items[0], last = items.at(-1)
      if (!items.length) event.preventDefault()
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <h2 id="delete-coach-title">Delete coach?</h2>
    <p id="delete-coach-detail">“{name}” and its memory will be permanently deleted. This cannot be undone.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions"><button ref={cancel} className="action-button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="action-button" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete coach'}</button></div>
  </div></div>, document.body)
}
