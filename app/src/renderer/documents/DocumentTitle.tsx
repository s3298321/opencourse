import { useEffect, useRef, useState } from 'react'

export default function DocumentTitle({ title, onRename }: { title: string; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), editingNow = useRef(false), savingNow = useRef(false)
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  const cancel = (): void => { editingNow.current = false; setEditing(false); setError(null) }
  const save = async (): Promise<void> => {
    if (!editingNow.current || savingNow.current) return
    const name = draft.trim()
    if (!name) { setError('Enter a document title.'); return }
    if (name === title) { cancel(); return }
    savingNow.current = true; setSaving(true); setError(null)
    try { await onRename(name); cancel() }
    catch (error) { setError((error as Error).message) }
    finally { savingNow.current = false; setSaving(false) }
  }
  return editing ? <form className="document-title-edit" onSubmit={event => { event.preventDefault(); void save() }}>
    <input ref={input} aria-label="Document title" aria-invalid={!!error} aria-describedby={error ? 'document-title-error' : undefined} aria-busy={saving} value={draft} maxLength={300} readOnly={saving}
      onChange={event => { setDraft(event.target.value); setError(null) }} onBlur={() => void save()}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!savingNow.current) cancel() } }} />
    {error && <p id="document-title-error" className="document-title-error" role="alert">{error}</p>}
  </form> : <h2><button className="document-title" aria-label={`Rename document: ${title}`} title="Click to rename" onClick={() => { setDraft(title); setError(null); editingNow.current = true; setEditing(true) }}>{title}</button></h2>
}
