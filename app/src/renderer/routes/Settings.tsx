import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CoachModel, Session, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import { AIModelsSection, SubscriptionSection } from '../components/AISettings'
import TitleGenerationSection from '../components/TitleGenerationSettings'
import ThemeSection from '../components/ThemeSettings'
import ServerSettings from '../components/ServerSettings'
import ConnectionIcon from '../components/ConnectionIcon'
import type { Route, Screen } from '../routes'

interface Props {
  user: UserProfile | null
  navigate: (r: Route, options?: { keepScroll?: boolean }) => void
  route: { name: 'settings'; from: Screen }
  onSession: (session: Session) => void
  onSessionChanged: (session: Session, user: UserProfile | null) => void
}

/**
 * Everything about *you*, in one place: your name, your OpenAI key, which of
 * the models it reaches the side chat offers, and the button that removes all
 * of it.
 *
 * The key used to be a modal reachable only from inside Coach, which made the
 * app's API credential look like a Coach feature - side chat can use the same
 * key and had to grow its own door to the same dialog. It lives here now, and
 * both of those places link to this screen instead.
 *
 * The key handling itself is unchanged and deliberately so: a password field,
 * cleared the moment it is submitted, checked with OpenAI before it is stored,
 * and never read back - `hasOpenAIKey` returns a boolean and four characters.
 */
export default function Settings({ user, navigate, route, onSession, onSessionChanged }: Props): JSX.Element {
  const back = useCallback(() => navigate(route.from, { keepScroll: true }), [navigate, route.from])
  // Bumped when the key is saved or forgotten: the model list is whatever the
  // key reaches, so a new key is a new list.
  const [keyVersion, setKeyVersion] = useState(0)
  const onKeyChanged = useCallback(() => setKeyVersion((n) => n + 1), [])
  useEffect(() => window.opencourse.onAIChanged(onKeyChanged), [onKeyChanged])

  return (
    <>
      <TitleBar
        user={user}
        navigate={navigate}
        route={route}
        back={{ label: 'Back', onClick: back }}
      />
      <div className="body">
        <div className="content scroll">
          <div className="settings">
            <h1>Settings</h1>
            {/* App derives the user from a session that is null until its mount
                effect resolves, so this is a frame, not an error. */}
            {!user ? (
              <p className="meta">Loading…</p>
            ) : (
              <>
                <NameSection user={user} onSession={onSession} />
                <ThemeSection />
                <ServerSettings />
                <h2>Connections</h2>
                <KeySection onChanged={onKeyChanged} />
                <SubscriptionSection />
                <WebSearchSection />
                <AIModelsSection scope="chat" version={keyVersion} />
                <AIModelsSection scope="project" version={keyVersion} />
                <AIModelsSection scope="authoring" version={keyVersion} />
                <TitleGenerationSection version={keyVersion} />
                <CoachDefaultsSection keyVersion={keyVersion} />
                <DangerSection user={user} onSessionChanged={onSessionChanged} />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/* --- your name ----------------------------------------------------------- */

function NameSection({
  user,
  onSession
}: {
  user: UserProfile
  onSession: (session: Session) => void
}): JSX.Element {
  const [name, setName] = useState(user.name)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)

  const changed = name.trim() !== '' && name.trim() !== user.name

  const save = async (): Promise<void> => {
    if (!changed || busy) return
    setBusy(true)
    setNote(null)
    try {
      await window.opencourse.renameUser(name)
      // Re-reading the session is what updates the chip in the titlebar. It
      // must not navigate: you asked to be called something else, not to be
      // taken somewhere else.
      onSession(await window.opencourse.getSession())
      setNote({ text: 'Saved.', error: false })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Your name</h2>
      <p className="meta">
        What the app calls you, and how you tell yourself apart on the picker. Nothing is named after it
        on disk, so changing it moves nothing.
      </p>
      <div className="settings-row">
        <input
          type="text"
          className="settings-name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <button disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {note && <p className={`import-note${note.error ? ' error' : ''}`}>{note.text}</p>}
    </section>
  )
}

/* --- your OpenAI key ------------------------------------------------------ */

function KeySection({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [stored, setStored] = useState<{ has: boolean; hint: string | null } | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const field = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(() => {
    void window.opencourse.hasOpenAIKey().then(setStored)
  }, [])
  useEffect(refresh, [refresh])

  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setNote({ text: 'Checking it with OpenAI…', error: false })
    try {
      const result = await window.opencourse.setOpenAIKey(key)
      // Whatever happened, stop holding it here.
      setKey('')
      if (result.status === 'ok') {
        refresh()
        onChanged()
        setNote({ text: 'Saved.', error: false })
        return
      }
      if (result.status === 'unavailable') {
        setNote({
          text:
            'That key works, but this Mac has no keychain available, so OpenCourse will not write it down. ' +
            'It will last until you quit.',
          error: false
        })
        refresh()
        onChanged()
        return
      }
      setNote({ text: result.message, error: true })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }

  const forget = async (): Promise<void> => {
    if (!window.confirm('Forget the stored OpenAI key?\n\nYou will need to paste it again to start a session.'))
      return
    await window.opencourse.clearOpenAIKey()
    refresh()
    onChanged()
    setNote({ text: 'Forgotten.', error: false })
  }

  return (
    <section className={`settings-section${stored?.has ? ' settings-key-ready' : ''}`}>
      <h2 className="settings-connection-heading"><ConnectionIcon provider="apiKey" />Your OpenAI key</h2>
      <div className={`settings-key-status${stored?.has ? ' ready' : ''}`} role="status">
        <span className="settings-key-badge">
          {stored?.has && <span aria-hidden="true">✓</span>}
          {stored === null ? 'Loading key status…' : stored.has ? 'Key ready' : 'No key added'}
        </span>
        {stored?.has && stored.hint && <span className="settings-key-hint">Ending {stored.hint}</span>}
      </div>
      {stored?.has === false && <p className="meta">Add a key for Coach or to use API billing for chat and the project assistant.</p>}
      <p className="meta">
        The key is encrypted with your macOS keychain and stays on this Mac. OpenCourse sends it to OpenAI and
        nowhere else, and it is never shown again once saved. Each person using OpenCourse on this Mac needs
        their own — a key is what OpenAI bills.
      </p>

      <input
        ref={field}
        type="password"
        className="settings-key"
        value={key}
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-…"
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
      />

      {note && <p className={`import-note${note.error ? ' error' : ''}`}>{note.text}</p>}

      <div className="actions">
        <button disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? 'Checking…' : stored?.has ? 'Replace key' : 'Save key'}
        </button>
        {stored?.has && (
          <button className="secondary" disabled={busy} onClick={() => void forget()}>
            Forget it
          </button>
        )}
      </div>

      <p className="meta">
        API requests are billed by OpenAI. Coach uses this key for voice sessions and transcription.
        A ChatGPT subscription does not cover Coach.
      </p>
    </section>
  )
}

/* --- web search ------------------------------------------------------------ */

/**
 * Beside the key because it is a question about the key: every search is
 * billed on it, on top of the answer. Off until someone turns it on, and when
 * it is on the model still decides, question by question, whether to search.
 */
function WebSearchSection(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.opencourse.getChatWebSearch().then(setOn)
  }, [])

  const toggle = async (next: boolean): Promise<void> => {
    setError(null)
    setOn(next)
    try {
      setOn(await window.opencourse.setChatWebSearch(next))
    } catch (err) {
      setOn(!next)
      setError((err as Error).message)
    }
  }

  return (
    <section className="settings-section">
      <h2>Web search</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          className="settings-web-search"
          checked={on === true}
          disabled={on === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Let the side chat search the web when a question needs it</span>
      </label>
      <p className="meta">
        The model decides when a question needs it - a release date, a current version, documentation the
        lesson does not quote. Searches use chat’s selected connection when supported. API-key searches
        add API charges; subscription searches use eligible plan usage. Answers that use the web list their sources.
      </p>
      {error && <p className="import-note error">{error}</p>}
    </section>
  )
}

function CoachDefaultsSection({ keyVersion }: { keyVersion: number }): JSX.Element {
  const [models, setModels] = useState<CoachModel[]>([])
  const [model, setModel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setModel(null)
    setError(null)
    void Promise.all([window.opencourse.listCoachModels(), window.opencourse.getDefaultCoachModel()])
      .then(([list, selected]) => {
        if (cancelled) return
        setModels(list.models)
        setModel(selected)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => { cancelled = true }
  }, [keyVersion])

  const save = async (next: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      setModel(await window.opencourse.setDefaultCoachModel(next))
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Coach model</h2>
      <p className="meta">Choose the speech-to-speech model new coaches start with.</p>
      <div className="settings-defaults">
        <label>
          <span>Default speech-to-speech model</span>
          <select
            className="settings-default-coach-model"
            value={model ?? ''}
            disabled={model === null || busy}
            onChange={(e) => void save(e.target.value)}
          >
            {model === null && <option value="">Loading models…</option>}
            {model && !models.some((option) => option.id === model) && <option value={model} disabled>{model} (unavailable)</option>}
            {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {saved && <p className="import-note" role="status">Default saved.</p>}
      {error && <p className="import-note error">{error}</p>}
    </section>
  )
}

/* --- deleting yourself ---------------------------------------------------- */

function DangerSection({
  user,
  onSessionChanged
}: {
  user: UserProfile
  onSessionChanged: (session: Session, user: UserProfile | null) => void
}): JSX.Element {
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The most destructive button in the app, and now one menu click away rather
  // than a trip to the picker. A window.confirm is one keystroke from Enter; a
  // name typed out is a decision.
  const ready = typed.trim() === user.name

  const remove = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const session = await window.opencourse.deleteUser(user.id)
      // Nobody is selected any more, so this both refreshes the session and
      // lands on the picker. Nothing after it may route back to `from`.
      onSessionChanged(session, null)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <section className="settings-section danger">
      <h2>Delete this user</h2>
      {!arming ? (
        <>
          <p className="meta">Removes {user.name} and everything they own on this Mac.</p>
          <div className="actions">
            <button className="secondary danger" onClick={() => setArming(true)}>
              Delete…
            </button>
          </div>
        </>
      ) : (
        <>
          <p>This deletes, permanently and with no undo:</p>
          <ul className="meta">
            <li>every course {user.name} imported, and their progress through it</li>
            <li>every exercise file they wrote, and the virtualenvs built for them</li>
            <li>every coach, its sessions, its transcripts and the files it wrote</li>
            <li>every side chat and its messages</li>
            <li>their stored OpenAI key and ChatGPT connection credentials</li>
          </ul>
          <p className="meta">
            Type <strong>{user.name}</strong> to confirm.
          </p>
          <div className="settings-row">
            <input
              type="text"
              autoFocus
              value={typed}
              placeholder={user.name}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void remove()
                if (e.key === 'Escape') setArming(false)
              }}
            />
            <button className="danger" disabled={!ready || busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setArming(false)
                setTyped('')
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p className="import-note error">{error}</p>}
    </section>
  )
}
