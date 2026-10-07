import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { emailProblem, passwordProblem, usernameProblem, type ServerInfo } from '@core/catalog/api'
import type { ServerConnection, ServerResult } from '@core/types'

/**
 * Settings → Servers: the OpenCourse servers this user has connected to, which
 * one the Library's catalog shows, and connecting to another.
 *
 * Connecting is a conversation held right here, never in a browser: the
 * address, then either an existing account or a new one - email, a code from
 * that email, a username, a password. Each server has its own account; the
 * app keeps a token per server in the keychain and never the password.
 */
export default function ServerSettings(): JSX.Element {
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  const [connecting, setConnecting] = useState<{ url?: string; signIn?: boolean } | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)

  const refresh = useCallback(() => { void window.opencourse.listServers().then(setServers).catch(() => setServers([])) }, [])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onServersChanged(refresh), [refresh])

  const act = async (work: () => Promise<ServerResult<ServerConnection[]>>, done: string): Promise<void> => {
    const result = await work()
    if (result.ok) { setServers(result.value); setNote({ text: done, error: false }) } else setNote({ text: result.message, error: true })
  }

  return (
    <section className="settings-section server-settings">
      <h2>Servers</h2>
      <p className="meta">
        Connect to an OpenCourse server to browse its catalog, add its courses and publish your own. Each server
        has its own account; you can be connected to several and choose which catalog the Library shows.
      </p>
      {servers === null ? <p className="meta">Loading…</p> : servers.length > 0 && (
        <ul className="server-list">
          {servers.map((server) => (
            <li key={server.id} className={`server-card${server.active ? ' active' : ''}`}>
              <label className="server-card-pick">
                <input type="radio" name="active-server" checked={server.active} aria-label={`Show the catalog of ${server.name}`}
                  onChange={() => { void window.opencourse.setActiveServer(server.id).then(setServers) }} />
                <span className="server-card-text">
                  <strong>{server.name}</strong>
                  <span className="meta server-card-url">{server.url}</span>
                  <span className={`server-card-account${server.account ? ' signed-in' : ''}`}>
                    {server.account ? `Signed in as ${server.account.username} (${server.account.email})` : 'Signed out'}
                  </span>
                </span>
              </label>
              <div className="actions">
                {server.account
                  ? <button className="secondary" onClick={() => void act(() => window.opencourse.signOutOfServer(server.id), `Signed out of ${server.name}.`)}>Sign out</button>
                  : <button className="secondary" onClick={() => { setNote(null); setConnecting({ url: server.url, signIn: true }) }}>Sign in…</button>}
                <button className="secondary danger" onClick={() => {
                  if (!window.confirm(`Remove ${server.name}?\n\nYou will be signed out. Courses you added from it stay in your library, but cannot be updated until you connect to it again.`)) return
                  void act(() => window.opencourse.removeServer(server.id), `Removed ${server.name}.`)
                }}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {note && <p className={`import-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
      {connecting
        ? <ServerConnect initialUrl={connecting.url} startWithSignIn={connecting.signIn} onDone={(connection) => {
            setConnecting(null)
            if (connection) { setNote({ text: `Connected to ${connection.name} as ${connection.account?.username}.`, error: false }); refresh() }
          }} />
        : <div className="actions"><button onClick={() => { setNote(null); setConnecting({}) }}>Connect to a server…</button></div>}
    </section>
  )
}

type Step =
  | { kind: 'address' }
  | { kind: 'choose'; url: string; info: ServerInfo }
  | { kind: 'email'; url: string; info: ServerInfo }
  | { kind: 'code'; url: string; info: ServerInfo; flowId: string; email: string }
  | { kind: 'username'; url: string; info: ServerInfo; flowId: string }
  | { kind: 'password'; url: string; info: ServerInfo; flowId: string; username: string }
  | { kind: 'signin'; url: string; info: ServerInfo }
  | { kind: 'reset-email'; url: string; info: ServerInfo }
  | { kind: 'reset'; url: string; info: ServerInfo; flowId: string; email: string }

const RESEND_AFTER_S = 30

/** The connect flow, one question at a time. Passwords are cleared the moment they are sent. */
export function ServerConnect({ initialUrl, startWithSignIn, onDone }: { initialUrl?: string; startWithSignIn?: boolean; onDone: (connection: ServerConnection | null) => void }): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'address' })
  const [url, setUrl] = useState(initialUrl ?? '')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [available, setAvailable] = useState<{ name: string; available: boolean; reason?: string } | null>(null)
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  useEffect(() => {
    if (resendIn <= 0) return undefined
    const timer = setTimeout(() => setResendIn((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendIn])

  // An existing connection that is signed out goes straight to its sign-in.
  useEffect(() => {
    if (!initialUrl) return
    void run(() => window.opencourse.probeServer(initialUrl), (probed) => setStep({ kind: startWithSignIn ? 'signin' : 'choose', url: probed.url, info: probed.info }))
  }, [])

  // The name is checked as it is typed: the rule at once, the server after a pause.
  useEffect(() => {
    if (step.kind !== 'username' || !username || usernameProblem(username)) { setAvailable(null); return undefined }
    const timer = setTimeout(() => {
      void window.opencourse.checkServerUsername(step.flowId, username).then((result) => {
        if (result.ok) setAvailable({ name: username, ...result.value })
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [step, username])

  async function run<T>(work: () => Promise<ServerResult<T>>, next: (value: T) => void): Promise<void> {
    setBusy(true); setError(null)
    try {
      const result = await work()
      if (result.ok) next(result.value)
      else setError(result.message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const server = 'info' in step ? step.info : null
  const passwordIssue = password ? passwordProblem(password) : null
  const mismatch = confirm.length > 0 && confirm !== password
  const nameIssue = username ? usernameProblem(username) : null

  let body: JSX.Element
  switch (step.kind) {
    case 'address':
      body = <form onSubmit={(e) => { e.preventDefault(); void run(() => window.opencourse.probeServer(url), (probed) => { setUrl(probed.url); setStep({ kind: startWithSignIn ? 'signin' : 'choose', url: probed.url, info: probed.info }) }) }}>
        <label className="server-field">Server address
          <input autoFocus type="text" value={url} placeholder="courses.example.org" autoComplete="url" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <p className="meta">The address of an OpenCourse server, as its operator gave it to you.</p>
        <div className="actions"><button type="submit" disabled={busy || !url.trim()}>{busy ? 'Checking…' : 'Continue'}</button></div>
      </form>
      break
    case 'choose':
      body = <div>
        <p className="meta">{step.info.description}</p>
        <div className="actions">
          <button autoFocus disabled={step.info.registration === 'closed'} onClick={() => setStep({ kind: 'email', url: step.url, info: step.info })}>Create an account</button>
          <button className="secondary" onClick={() => setStep({ kind: 'signin', url: step.url, info: step.info })}>I have an account</button>
        </div>
        {step.info.registration === 'closed' && <p className="meta">This server is not accepting new accounts.</p>}
      </div>
      break
    case 'email':
      body = <form onSubmit={(e) => { e.preventDefault(); void run(() => window.opencourse.startServerSignUp(step.url, email), (started) => { setResendIn(RESEND_AFTER_S); setCode(''); setStep({ kind: 'code', url: step.url, info: step.info, flowId: started.flowId, email: email.trim() }) }) }}>
        <label className="server-field">Email address
          <input autoFocus type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <p className="meta">{step.info.name} sends a 6-digit code to this address to confirm it is yours.</p>
        <div className="actions"><button type="submit" disabled={busy || !email.trim() || Boolean(emailProblem(email.trim()))}>{busy ? 'Sending…' : 'Send code'}</button></div>
      </form>
      break
    case 'code':
      body = <form onSubmit={(e) => { e.preventDefault(); void run(() => window.opencourse.verifyServerCode(step.flowId, code), () => { setUsername(''); setStep({ kind: 'username', url: step.url, info: step.info, flowId: step.flowId }) }) }}>
        <p className="meta">Enter the code {step.info.name} sent to <strong>{step.email}</strong>. It expires in 10 minutes.</p>
        <label className="server-field">Code
          <input autoFocus className="server-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" className="secondary" disabled={busy || resendIn > 0} onClick={() => void run(() => window.opencourse.resendServerCode(step.flowId), () => setResendIn(RESEND_AFTER_S))}>
            {resendIn > 0 ? `Send again in ${resendIn}s` : 'Send a new code'}
          </button>
        </div>
      </form>
      break
    case 'username':
      body = <form onSubmit={(e) => { e.preventDefault(); if (!nameIssue && available?.available && available.name === username) { setPassword(''); setConfirm(''); setStep({ kind: 'password', url: step.url, info: step.info, flowId: step.flowId, username }) } }}>
        <p className="meta">Your address is confirmed. Choose the name others see on courses you publish on {step.info.name}.</p>
        <label className="server-field">Username
          <input autoFocus type="text" value={username} autoComplete="username" spellCheck={false} maxLength={32} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </label>
        <p className={`meta server-username-state${available?.available && available.name === username ? ' ok' : ''}`} role="status">
          {nameIssue ?? (available && available.name === username ? (available.available ? 'Available.' : available.reason ?? 'Not available.') : username ? 'Checking…' : 'Lowercase letters, digits, "-" and "_".')}
        </p>
        <div className="actions"><button type="submit" disabled={busy || Boolean(nameIssue) || !(available?.available && available.name === username)}>Continue</button></div>
      </form>
      break
    case 'password':
      body = <form onSubmit={(e) => {
        e.preventDefault()
        const chosen = password
        setPassword(''); setConfirm('')
        void run(() => window.opencourse.completeServerSignUp(step.flowId, step.username, chosen), (connection) => onDone(connection))
      }}>
        <p className="meta">Set a password for <strong>{step.username}</strong> on {step.info.name}. It is used only for this server; OpenCourse keeps a sign-in token, never the password.</p>
        <label className="server-field">Password
          <input autoFocus type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="server-field">Repeat the password
          <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {(passwordIssue || mismatch) && <p className="meta error">{passwordIssue ?? 'The two passwords differ.'}</p>}
        <div className="actions"><button type="submit" disabled={busy || !password || Boolean(passwordIssue) || confirm !== password}>{busy ? 'Creating…' : 'Create account'}</button></div>
      </form>
      break
    case 'signin':
      body = <form onSubmit={(e) => {
        e.preventDefault()
        const secret = password
        setPassword('')
        void run(() => window.opencourse.signInToServer(step.url, login, secret), (connection) => onDone(connection))
      }}>
        <label className="server-field">Email or username
          <input autoFocus type="text" value={login} autoComplete="username" spellCheck={false} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="server-field">Password
          <input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || !login.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="ghost" onClick={() => { setEmail(login.includes('@') ? login : ''); setStep({ kind: 'reset-email', url: step.url, info: step.info }) }}>Forgot password?</button>
        </div>
      </form>
      break
    case 'reset-email':
      body = <form onSubmit={(e) => { e.preventDefault(); void run(() => window.opencourse.startServerPasswordReset(step.url, email), (started) => { setCode(''); setPassword(''); setConfirm(''); setStep({ kind: 'reset', url: step.url, info: step.info, flowId: started.flowId, email: email.trim() }) }) }}>
        <label className="server-field">Email address of your account
          <input autoFocus type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <p className="meta">If this address has an account on {step.info.name}, it is sent a code to set a new password.</p>
        <div className="actions"><button type="submit" disabled={busy || Boolean(emailProblem(email.trim()))}>{busy ? 'Sending…' : 'Send code'}</button></div>
      </form>
      break
    case 'reset':
      body = <form onSubmit={(e) => {
        e.preventDefault()
        const chosen = password
        setPassword(''); setConfirm('')
        void run(() => window.opencourse.finishServerPasswordReset(step.flowId, code, chosen), (connection) => onDone(connection))
      }}>
        <p className="meta">Enter the code sent to <strong>{step.email}</strong> and choose a new password. Every other device signed in to this account is signed out.</p>
        <label className="server-field">Code
          <input autoFocus className="server-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <label className="server-field">New password
          <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="server-field">Repeat the new password
          <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {(passwordIssue || mismatch) && <p className="meta error">{passwordIssue ?? 'The two passwords differ.'}</p>}
        <div className="actions"><button type="submit" disabled={busy || code.length !== 6 || Boolean(passwordIssue) || confirm !== password}>{busy ? 'Saving…' : 'Set password and sign in'}</button></div>
      </form>
      break
  }

  return (
    <div className="server-connect" aria-live="polite">
      <div className="server-connect-head">
        <h3>{server ? server.name : 'Connect to a server'}</h3>
        {server && <span className="meta">{'url' in step ? step.url : ''}</span>}
      </div>
      {body}
      {error && <p className="import-note error" role="alert">{error}</p>}
      <div className="actions server-connect-foot">
        <button type="button" className="ghost" onClick={() => { setPassword(''); setConfirm(''); onDone(null) }}>Cancel</button>
      </div>
    </div>
  )
}
