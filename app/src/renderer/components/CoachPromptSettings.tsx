import { useEffect, useState, type JSX } from 'react'
import type { CoachPrompts } from '@core/types'
import { COACH_PROMPT_KEYS, DEFAULT_COACH_PROMPTS, MAX_COACH_PROMPT_LENGTH } from '@core/coach/prompt-defaults'
import ActionButton from './ActionButton'
import SettingsDisclosure from './SettingsDisclosure'

const FIELDS: Record<keyof CoachPrompts, { label: string; description: string }> = {
  shared: { label: 'Shared coaching instructions', description: 'The teaching approach and memory habits shared by both models.' },
  voice: { label: 'Voice model instructions', description: 'How the coach speaks, listens, and asks its background model for help.' },
  backend: { label: 'Background model instructions', description: 'How the background model reasons, researches, and maintains learning notes.' },
  firstConversation: { label: 'First conversation', description: 'Additional guidance for both models when a coach starts its first conversation.' },
  followingConversations: { label: 'Following conversations', description: 'Additional guidance for both models after a coach has a recorded conversation.' }
}

export default function CoachPromptSettings(): JSX.Element {
  const [draft, setDraft] = useState<CoachPrompts | null>(null)
  const [stored, setStored] = useState<CoachPrompts | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.opencourse.getDefaultCoachPrompts().then(prompts => {
      if (!cancelled) { setDraft(prompts); setStored(prompts) }
    }).catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [])
  const dirty = draft && COACH_PROMPT_KEYS.some(key => draft[key] !== stored?.[key])
  const valid = draft && COACH_PROMPT_KEYS.every(key => draft[key].trim().length > 0 && draft[key].length <= MAX_COACH_PROMPT_LENGTH)
  const save = async (): Promise<void> => {
    if (!draft || busy || !valid) return
    setBusy(true); setError(null); setSaved(false)
    try {
      const prompts = await window.opencourse.setDefaultCoachPrompts(draft)
      setStored(prompts); setDraft(prompts); setSaved(true)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="settings-section settings-coach-prompts">
    <h2>Prompts for new coaches</h2>
    {!draft ? <p className="meta">{error ? 'Prompts could not be loaded. Reopen Settings to try again.' : 'Loading prompts…'}</p> : <>
      {COACH_PROMPT_KEYS.map(key => <SettingsDisclosure key={key} title={FIELDS[key].label}
        className="settings-coach-prompt" defaultExpanded={key === 'shared'}>
        <p className="meta" id={`coach-prompt-${key}-help`}>{FIELDS[key].description}</p>
        <label>
          <span className="sr-only">{FIELDS[key].label}</span>
          <textarea className="settings-key" data-coach-prompt={key} aria-describedby={`coach-prompt-${key}-help`}
            value={draft[key]} rows={key === 'shared' || key === 'voice' ? 10 : 6} maxLength={MAX_COACH_PROMPT_LENGTH} disabled={busy}
            onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setSaved(false) }} />
        </label>
        <div className="actions">
          <ActionButton icon="reset" className="secondary" disabled={busy || draft[key] === DEFAULT_COACH_PROMPTS[key]}
            onClick={() => { setDraft({ ...draft, [key]: DEFAULT_COACH_PROMPTS[key] }); setSaved(false) }}>Restore default</ActionButton>
          <span className="meta">{draft[key].length.toLocaleString()} / {MAX_COACH_PROMPT_LENGTH.toLocaleString()} characters</span>
        </div>
      </SettingsDisclosure>)}
      {!valid && <p className="import-note error">Each prompt needs text. Use Restore default to reset a prompt.</p>}
      <div className="actions">
        <ActionButton icon="save" className="settings-save-coach-prompts" disabled={busy || !dirty || !valid} onClick={() => void save()}>Save prompts</ActionButton>
        <ActionButton icon="close" className="secondary" disabled={busy || !dirty} onClick={() => { setDraft(stored); setSaved(false); setError(null) }}>Discard changes</ActionButton>
      </div>
    </>}
    {saved && <p className="import-note" role="status">Prompts saved for new coaches.</p>}
    {error && <p className="import-note error" role="alert">{error}</p>}
  </section>
}
