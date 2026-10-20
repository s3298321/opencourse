import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { PUBLIC_LINKS } from '@core/links'
import type { AppInfo, AppLinks, AppUpdateInfo, CoachModel, Session, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import { AIModelsSection, SubscriptionSection } from '../components/AISettings'
import TitleGenerationSection from '../components/TitleGenerationSettings'
import ThemeSection from '../components/ThemeSettings'
import PomodoroSettings from '../components/PomodoroSettings'
import ServerSettings from '../components/ServerSettings'
import ConnectionIcon from '../components/ConnectionIcon'
import { formatDownloadSize, useAppUpdate } from '../components/useAppUpdate'
import type { Route, Screen, SettingsSection } from '../routes'

interface Props {
  user: UserProfile | null
  navigate: (r: Route, options?: { keepScroll?: boolean }) => void
  route: { name: 'settings'; from: Screen; section?: SettingsSection }
  onSession: (session: Session) => void
  onSessionChanged: (session: Session, user: UserProfile | null) => void
}

const CATEGORIES: Array<{ id: SettingsSection; label: string }> = [
  { id: 'profile', label: 'Profile' }, { id: 'appearance', label: 'Appearance' },
  { id: 'pomodoro', label: 'Pomodoro' },
  { id: 'connections', label: 'Connections' }, { id: 'ai', label: 'AI & Chat' },
  { id: 'coach', label: 'Coach' }, { id: 'servers', label: 'Course Servers' },
  { id: 'updates', label: 'Updates' }, { id: 'about', label: 'About' }
]
const websiteLinks = (links: AppLinks): Array<{ label: string; href: string }> => [
  { label: 'Legal notice', href: links.legal },
  { label: 'Main website', href: links.website },
  { label: 'Course catalog', href: links.catalog }
]

export default function Settings({ user, navigate, route, onSession, onSessionChanged }: Props): JSX.Element {
  const back = useCallback(() => navigate(route.from, { keepScroll: true }), [navigate, route.from])
  const [section, setSection] = useState<SettingsSection>(route.section ?? 'profile')
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([route.section ?? 'profile']))
  const select = useCallback((next: SettingsSection) => {
    setSection(next)
    setVisited(current => new Set([...current, next]))
  }, [])
  useEffect(() => { if (route.section) select(route.section) }, [route, select])
  const [keyVersion, setKeyVersion] = useState(0)
  const onKeyChanged = useCallback(() => setKeyVersion(n => n + 1), [])
  useEffect(() => window.opencourse.onAIChanged(onKeyChanged), [onKeyChanged])
  // Main says which site and catalog: the public ones, or a dev run's local twins.
  const [links, setLinks] = useState<AppLinks>(PUBLIC_LINKS)
  useEffect(() => { void window.opencourse.getAppLinks?.().then(setLinks).catch(() => undefined) }, [])

  const content = (category: SettingsSection): JSX.Element => {
    switch (category) {
      case 'profile': return user ? <><NameSection user={user} onSession={onSession} /><DangerSection user={user} onSessionChanged={onSessionChanged} /></> : <p className="meta">Choose a user to edit their profile.</p>
      case 'appearance': return <ThemeSection />
      case 'pomodoro': return user ? <PomodoroSettings /> : <p className="meta">Choose a user to configure Pomodoro.</p>
      case 'connections': return <><KeySection onChanged={onKeyChanged} /><SubscriptionSection /></>
      case 'ai': return <><WebSearchSection /><WebSearchSection authoring /><AIModelsSection scope="chat" version={keyVersion} /><AIModelsSection scope="project" version={keyVersion} /><AIModelsSection scope="authoring" version={keyVersion} /><TitleGenerationSection version={keyVersion} /></>
      case 'coach': return <CoachDefaultsSection keyVersion={keyVersion} />
      case 'servers': return <ServerSettings />
      case 'updates': return <UpdatesSection focus={section === 'updates'} />
      case 'about': return <AboutSection />
    }
  }
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Back', onClick: back }} />
    <div className="body settings-body">
      <nav className="settings-nav scroll" aria-label="Settings categories">
        {CATEGORIES.map(category => <button key={category.id} className="ghost settings-category" data-settings-category={category.id}
          aria-current={section === category.id ? 'page' : undefined} aria-controls={`settings-${category.id}`} onClick={() => select(category.id)}>{category.label}</button>)}
        <div className="settings-links">{websiteLinks(links).map(link => <a key={link.href} href={link.href}>{link.label}<span aria-hidden="true">↗</span><span className="sr-only"> (opens in your browser)</span></a>)}</div>
      </nav>
      <div className="content settings-main">
        <h1>Settings</h1>
        {CATEGORIES.filter(category => visited.has(category.id)).map(category => <section key={category.id}
          id={`settings-${category.id}`} className="settings settings-category-panel scroll" hidden={section !== category.id} aria-label={category.label}>
          <h2 className="settings-category-heading">{category.label}</h2>{content(category.id)}
        </section>)}
      </div>
    </div>
  </>
}

function AboutSection(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    void window.opencourse.getAppInfo().then(value => { if (alive) setInfo(value) }).catch(err => { if (alive) setError((err as Error).message) })
    return () => { alive = false }
  }, [attempt])
  return <section className="settings-section settings-about">
    {error ? <><p className="error" role="alert">Could not load app information: {error}</p><ActionButton icon="refresh" className="secondary" onClick={() => setAttempt(n => n + 1)}>Retry</ActionButton></>
      : !info ? <p className="meta" role="status">Loading app information…</p> : <>
        <h2>{info.name}</h2><p className="meta">{info.description}</p>
        <dl className="about-details">
          <dt>App version</dt><dd>{info.version}</dd>
          <dt>Bundled Python</dt><dd>{info.python?.version ?? 'Unavailable'}</dd>
          <dt>Python distribution release</dt><dd>{info.python?.release ?? 'Unavailable'}</dd>
          <dt>Electron</dt><dd>{info.electron}</dd><dt>Chromium</dt><dd>{info.chromium}</dd><dt>Node.js</dt><dd>{info.node}</dd>
          <dt>Operating system</dt><dd>{info.platform === 'darwin' ? 'macOS' : info.platform}</dd><dt>Architecture</dt><dd>{info.architecture}</dd>
          <dt>License</dt><dd>{info.license}</dd><dt>Website</dt><dd><a href={info.links.website}>{new URL(info.links.website).host}</a></dd>
        </dl>
      </>}
  </section>
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
        <ActionButton icon="save" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Save'}
        </ActionButton>
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
        <ActionButton icon="key" disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? 'Checking' : stored?.has ? 'Replace key' : 'Save key'}
        </ActionButton>
        {stored?.has && (
          <ActionButton icon="trash" className="secondary" disabled={busy} onClick={() => void forget()}>
            Forget it
          </ActionButton>
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
/**
 * Updates of the app itself. Unlike everything around it this is not about you
 * but about the copy of the app every user here runs, and the page says so.
 * Automatic checks are off until ticked: while they are off the app never
 * contacts GitHub on its own (main/updates.ts).
 */
function UpdatesSection({ focus }: { focus: boolean }): JSX.Element {
  const info = useAppUpdate()
  const section = useRef<HTMLElement | null>(null)
  // Opened from the titlebar's update button: show this part, not the top.
  useEffect(() => {
    if (focus && info) section.current?.scrollIntoView({ block: 'start' })
  }, [focus, info === null])

  return (
    <section className="settings-section settings-updates" ref={section}>
      <h2>Updates</h2>
      {!info ? <p className="meta">Loading…</p> : <UpdatesBody info={info} />}
    </section>
  )
}

function UpdatesBody({ info }: { info: AppUpdateInfo }): JSX.Element {
  const status = info.status
  const busy = status.state === 'checking' || status.state === 'downloading' || status.state === 'verifying'
  const check = (): void => void window.opencourse.checkForAppUpdate()
  const install = (): void => void window.opencourse.installAppUpdate()
  const download = (): void => void window.opencourse.openExternal(info.downloadUrl)
  const notes = 'notesUrl' in status && status.notesUrl ? <> · <a href={status.notesUrl}>What’s new</a></> : null

  return (
    <>
      <p className="meta">
        This is OpenCourse {info.currentVersion}.
        {info.checkedAt !== null && ` Last checked ${new Date(info.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`}
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          className="settings-update-automatic"
          checked={info.automatic}
          onChange={(e) => void window.opencourse.setAppUpdateAutomatic(e.target.checked)}
        />
        <span>Check for updates automatically</span>
      </label>
      <p className="meta">
        For every OpenCourse user on this Mac account. A check asks GitHub, where OpenCourse is published, for the
        latest version. While this is off, OpenCourse never does that on its own - only when you press the button.
      </p>

      <div className="settings-update-status" role="status">
        {status.state === 'current' && <p>You have the latest version.</p>}
        {status.state === 'available' && (
          <p>
            <strong>OpenCourse {status.version} is available</strong> · {formatDownloadSize(status.size)}{notes}
            {!status.installable && status.reason && <span className="meta settings-update-reason">{status.reason}</span>}
          </p>
        )}
        {status.state === 'blocked' && (
          <p>
            <strong>OpenCourse {status.version} is waiting</strong>{notes}
            <span className="meta settings-update-reason">{status.reason}</span>
          </p>
        )}
        {status.state === 'downloading' && (
          <>
            <p>Downloading OpenCourse {status.version}…</p>
            <progress className="settings-update-progress" value={status.received} max={status.total} />
          </>
        )}
        {status.state === 'verifying' && <p>Checking the download…</p>}
        {status.state === 'ready' && <p><strong>OpenCourse {status.version} is ready.</strong> It is installed when OpenCourse restarts.</p>}
        {status.state === 'error' && <p className="import-note error">{status.message}</p>}
      </div>

      <div className="actions">
        {(status.state === 'available' && status.installable) || status.state === 'blocked' ? (
          <ActionButton icon="refresh" className="settings-update-install" onClick={install}>Install and restart</ActionButton>
        ) : null}
        {status.state === 'ready' && <ActionButton icon="refresh" className="settings-update-install" onClick={install}>Restart to update</ActionButton>}
        {((status.state === 'available' && !status.installable) || (status.state === 'error' && status.version)) && (
          <ActionButton icon="download" onClick={download}>Download OpenCourse {status.version}</ActionButton>
        )}
        <ActionButton icon="refresh" className="secondary settings-update-check" disabled={busy || status.state === 'ready'} onClick={check}>
          {status.state === 'checking' ? 'Checking' : 'Check for updates'}
        </ActionButton>
      </div>
    </>
  )
}

export function WebSearchSection({ authoring = false }: { authoring?: boolean }): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (authoring ? window.opencourse.getAuthoringWebSearch() : window.opencourse.getChatWebSearch()).then(setOn).catch(err => setError(err.message))
  }, [])

  const toggle = async (next: boolean): Promise<void> => {
    setError(null)
    setOn(next)
    try {
      setOn(await (authoring ? window.opencourse.setAuthoringWebSearch(next) : window.opencourse.setChatWebSearch(next)))
    } catch (err) {
      setOn(!next)
      setError((err as Error).message)
    }
  }

  return (
    <section className="settings-section">
      <h2>{authoring ? 'Course authoring web search' : 'Web search'}</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          className={authoring ? 'settings-authoring-web-search' : 'settings-web-search'}
          checked={on === true}
          disabled={on === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>{authoring ? 'Let the course assistant research the web while creating and editing courses' : 'Let the side chat search the web when a question needs it'}</span>
      </label>
      <p className="meta">
        {authoring ? 'Enabled by default. The assistant checks official documentation when teaching version-sensitive technology. Sources and verification notes stay in the authoring chat. ' : 'The model decides when a question needs it—a release date, a current version, or documentation the course or document does not quote. '}
        Searches use this feature’s selected connection when supported. API-key searches add API charges; subscription searches use eligible plan usage.
      </p>
      {error && <p className="import-note error">{error}</p>}
    </section>
  )
}

function CoachDefaultsSection({ keyVersion }: { keyVersion: number }): JSX.Element {
  const [allowDelete, setAllowDelete] = useState<boolean | null>(null)
  const [savingPermission, setSavingPermission] = useState(false)
  useEffect(() => {
    const load = () => { void window.opencourse.getCoachAllowDelete().then(setAllowDelete).catch(error => setError(error.message)) }
    load()
    return window.opencourse.onCoachChanged(load)
  }, [])
  const [models, setModels] = useState<CoachModel[]>([])
  const [model, setModel] = useState<string | null>(null)
  const [backendModels, setBackendModels] = useState<CoachModel[]>([])
  const [backendModel, setBackendModel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setModel(null)
    setBackendModel(null)
    setError(null)
    void Promise.all([
      window.opencourse.listCoachModels(), window.opencourse.getDefaultCoachModel(),
      window.opencourse.listCoachBackendModels(), window.opencourse.getDefaultCoachBackendModel()
    ])
      .then(([list, selected, backendList, selectedBackend]) => {
        if (cancelled) return
        setModels(list.models)
        setModel(selected)
        setBackendModels(backendList.models)
        setBackendModel(selectedBackend)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => { cancelled = true }
  }, [keyVersion])

  const save = async (next: string, background = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      if (background) setBackendModel(await window.opencourse.setDefaultCoachBackendModel(next))
      else setModel(await window.opencourse.setDefaultCoachModel(next))
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Coach</h2>
      <label className="coach-toggle">
        <input type="checkbox" className="settings-coach-delete" checked={allowDelete === true} disabled={allowDelete === null || savingPermission}
          onChange={event => {
            setSavingPermission(true); setError(null)
            void window.opencourse.setCoachAllowDelete(event.target.checked).then(setAllowDelete)
              .catch(error => setError(error.message)).finally(() => setSavingPermission(false))
          }} />
        <span>Let coaches delete their files</span>
      </label>
      <p className="meta">Files go to the coach’s trash. Enabling applies to new sessions; disabling blocks deletion immediately.</p>
      {model === null ? <p className="meta">Loading models…</p> : !models.length && !backendModels.length ? <p className="meta">Add an OpenAI API key in Connections to choose Coach models.</p> : <>
        <h3>Defaults for new coaches</h3>
        <div className="settings-defaults">
          <label>
            <span>Default voice model</span>
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
          <label>
            <span>Default background model</span>
            <select
              className="settings-default-coach-backend-model"
              value={backendModel ?? ''}
              disabled={backendModel === null || busy}
              onChange={(e) => void save(e.target.value, true)}
            >
              {backendModel === null && <option value="">Loading models…</option>}
              {backendModel && !backendModels.some(option => option.id === backendModel) && <option value={backendModel} disabled>{backendModel} (unavailable)</option>}
              {backendModels.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </>}
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
            <ActionButton icon="trash" className="secondary danger" onClick={() => setArming(true)}>
              Delete
            </ActionButton>
          </div>
        </>
      ) : (
        <>
          <p>This deletes, permanently and with no undo:</p>
          <ul className="meta">
            <li>every course {user.name} imported, and their progress through it</li>
            <li>every PDF document they imported, its local search index and document chats</li>
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
            <ActionButton icon="trash" className="danger" disabled={!ready || busy} onClick={() => void remove()}>
              {busy ? 'Deleting' : 'Delete for good'}
            </ActionButton>
            <ActionButton icon="close"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setArming(false)
                setTyped('')
              }}
            >
              Cancel
            </ActionButton>
          </div>
        </>
      )}
      {error && <p className="import-note error">{error}</p>}
    </section>
  )
}
