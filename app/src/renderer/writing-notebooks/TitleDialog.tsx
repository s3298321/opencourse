import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
export default function TitleDialog({ heading, initial = '', detail, placeholder = 'Notebook title', submitLabel = 'Save', maxLength = 200, pickFolder, onSubmit, onClose }: {
  heading: string; initial?: string; detail?: string; placeholder?: string; submitLabel?: string; maxLength?: number
  pickFolder?: () => Promise<string | null>
  onSubmit: (title: string, folder?: string | null) => Promise<void>; onClose: () => void
}) {
  const [title, setTitle] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [folder, setFolder] = useState<string | null>(null), [picking, setPicking] = useState(false)
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLFormElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; input.current?.focus(); input.current?.select(); return () => previous?.focus() }, [])
  const chooseFolder = () => {
    if (!pickFolder || busy || picking) return
    setPicking(true)
    void pickFolder().then(path => { if (path) setFolder(path) }).catch(e => setError(e.message)).finally(() => setPicking(false))
  }
  return createPortal(<div className="dialog-backdrop writing-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !busy) { event.preventDefault(); onClose() } }}><form ref={dialog} className="dialog writing-title-dialog" role="dialog" aria-modal="true" aria-labelledby="writing-dialog-title"
    onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') { const items = [...dialog.current!.querySelectorAll<HTMLElement>('input,button:not(:disabled)')]; const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
    }} onSubmit={event => { event.preventDefault(); if (busy || !title.trim()) return; setBusy(true); void onSubmit(title.trim(), pickFolder ? folder : undefined).then(onClose).catch(e => setError(e.message)).finally(() => setBusy(false)) }}>
    <h2 id="writing-dialog-title">{heading}</h2>{detail && <p>{detail}</p>}
    <input ref={input} type="text" aria-label={placeholder} placeholder={placeholder} value={title} maxLength={maxLength} disabled={busy} onChange={event => setTitle(event.target.value)} />
    {pickFolder && <div className="writing-folder-choice">
      {folder
        ? <span className="writing-folder-path" title={folder}><span className="writing-folder-path-text">{folder}</span><button type="button" className="writing-folder-clear" aria-label="Use the default location" disabled={busy} onClick={() => setFolder(null)}>×</button></span>
        : <><span className="writing-folder-label">Choose custom folder (optional):</span><button type="button" className="action-button secondary" disabled={busy || picking} onClick={chooseFolder}>{picking ? 'Choosing…' : 'Choose…'}</button></>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions"><button type="button" className="action-button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="action-button" disabled={busy || !title.trim()}>{busy ? 'Saving…' : submitLabel}</button></div>
  </form></div>, document.body)
}