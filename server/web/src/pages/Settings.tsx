import { useState, type FormEvent } from 'react'
import { useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router'
import { KeyRound, Laptop, LogOut, Mail, Monitor, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { emailProblem, isCode, passwordProblem, type SessionInfo } from '@core/catalog/api'
import { api, ApiError } from '../lib/api'
import { server } from '../lib/boot'
import { requireAccount, signedIn } from '../lib/guards'
import { session, useAccount } from '../lib/session'
import { ago, date, device } from '../lib/format'
import { CodeInput, FormError, PasswordField, TextField } from '../components/Forms'
import { Dialog } from '../components/Dialog'
import { Avatar } from '../components/Layout'
import { PageHeader, useTitle } from '../components/Bits'
import { useToast } from '../components/Toasts'
import { PasswordStrength } from './Auth'

export async function settingsLoader({ request }: LoaderFunctionArgs): Promise<SessionInfo[]> {
  requireAccount(request)
  return signedIn(request, async () => {
    const [{ account }, { sessions }] = await Promise.all([api.me(), api.sessions()])
    session.set(account)
    return sessions
  })
}

const message = (error: unknown): string => (error instanceof ApiError ? error.message : 'Something went wrong. Try again.')

export function SettingsPage() {
  useTitle('Settings')
  const account = useAccount()
  // Signed out (or the account deleted) while here: the page is about to leave.
  if (!account) return null
  return (
    <div className="oc-wrap page narrow">
      <PageHeader eyebrow="Your account" title="Settings" description={<>Signed in to {server.name} as <strong>{account.username}</strong>.</>} />
      <div className="settings oc-stagger">
        <Profile />
        <Password />
        <Sessions />
        <DangerZone />
      </div>
    </div>
  )
}

function Section({ icon, title, description, children, tone }: { icon: React.ReactNode; title: string; description?: React.ReactNode; children: React.ReactNode; tone?: 'danger' }) {
  return (
    <section className={`settings-section oc-panel${tone ? ` ${tone}` : ''}`}>
      <header className="settings-head">
        <span className="settings-icon" aria-hidden="true">{icon}</span>
        <div><h2>{title}</h2>{description && <p className="muted">{description}</p>}</div>
      </header>
      <div className="settings-body">{children}</div>
    </section>
  )
}

function Profile() {
  const account = useAccount()!
  const notify = useToast()
  const [step, setStep] = useState<'idle' | 'start' | 'code'>('idle')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reset = (): void => { setStep('idle'); setEmail(''); setPassword(''); setCode(''); setError(null) }
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await work() } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }
  return (
    <Section icon={<UserRound />} title="Profile" description="Your username is how you appear as a publisher, and cannot change.">
      <div className="profile-row">
        <Avatar name={account.username} size="lg" />
        <dl className="profile-facts">
          <div><dt>Username</dt><dd>{account.username}</dd></div>
          <div><dt>Email</dt><dd>{account.email}</dd></div>
          <div><dt>Member since</dt><dd>{date(account.createdAt)}</dd></div>
          {account.role === 'admin' && <div><dt>Role</dt><dd><span className="oc-pill silver"><ShieldCheck aria-hidden />Administrator</span></dd></div>}
        </dl>
        {step === 'idle' && <button type="button" className="oc-btn secondary" onClick={() => setStep('start')}><Mail aria-hidden />Change email</button>}
      </div>
      {step === 'start' && (
        <form className="inline-form oc-enter-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(async () => { await api.emailStart(email.trim(), password); setStep('code') }) }}>
          <FormError message={error} />
          <TextField label="New email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} error={email.trim() ? emailProblem(email.trim()) : null} />
          <PasswordField label="Current password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="form-actions"><button type="button" className="oc-btn secondary" onClick={reset}>Cancel</button><button type="submit" className="oc-btn" disabled={busy || !email.trim() || Boolean(emailProblem(email.trim())) || !password}>Send a code</button></div>
        </form>
      )}
      {step === 'code' && (
        <form className="inline-form oc-enter-sm" onSubmit={(e: FormEvent) => {
          e.preventDefault()
          void run(async () => {
            const r = await api.emailVerify(email.trim(), code)
            session.set(r.account)
            notify('Your email address was changed.')
            reset()
          })
        }}>
          <FormError message={error} />
          <p className="muted">Enter the code we sent to <strong>{email.trim()}</strong>. If that address already has an account, the email says so instead.</p>
          <CodeInput value={code} onChange={setCode} autoFocus disabled={busy} />
          <div className="form-actions"><button type="button" className="oc-btn secondary" onClick={reset}>Cancel</button><button type="submit" className="oc-btn" disabled={busy || !isCode(code)}>Confirm</button></div>
        </form>
      )}
    </Section>
  )
}

function Password() {
  const notify = useToast()
  const revalidator = useRevalidator()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const issue = next ? passwordProblem(next) : null
  return (
    <Section icon={<KeyRound />} title="Password" description="Changing it signs you out everywhere else.">
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault()
        setBusy(true); setError(null)
        api.changePassword(current, next)
          .then(() => { notify('Password changed. Every other session was signed out.'); setCurrent(''); setNext(''); revalidator.revalidate() })
          .catch((err: unknown) => setError(message(err)))
          .finally(() => setBusy(false))
      }}>
        <FormError message={error} />
        <div className="two-up">
          <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <PasswordField label="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={issue} hint={<PasswordStrength password={next} />} />
        </div>
        <div className="form-actions"><button type="submit" className="oc-btn" disabled={busy || !current || !next || Boolean(issue)}>{busy ? 'Saving…' : 'Change password'}</button></div>
      </form>
    </Section>
  )
}

function Sessions() {
  const sessions = useLoaderData() as SessionInfo[]
  const revalidator = useRevalidator()
  const notify = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const end = async (id: string | 'others'): Promise<void> => {
    setBusy(id)
    try {
      if (id === 'others') await api.endOtherSessions()
      else await api.endSession(id)
      notify(id === 'others' ? 'Signed out everywhere else.' : 'That session was signed out.')
      revalidator.revalidate()
    } catch (err) { notify(message(err), 'err') } finally { setBusy(null) }
  }
  const others = sessions.filter((s) => !s.current)
  return (
    <Section icon={<Monitor />} title="Where you are signed in" description="The OpenCourse app and browsers signed in to this account.">
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.id} className="session-row">
            <span className="session-icon" aria-hidden="true">{s.kind === 'app' ? <Laptop /> : <Monitor />}</span>
            <div className="session-main">
              <strong>{device(s.userAgent, s.kind)}</strong>
              <span className="muted">Signed in {date(s.createdAt)} · active {ago(s.lastUsedAt)}</span>
            </div>
            {s.current ? <span className="oc-pill ok"><span className="dot" />This browser</span>
              : <button type="button" className="oc-btn ghost sm" disabled={busy !== null} onClick={() => { void end(s.id) }}><LogOut aria-hidden />Sign out</button>}
          </li>
        ))}
      </ul>
      {others.length > 0 && <div className="form-actions"><button type="button" className="oc-btn secondary" disabled={busy !== null} onClick={() => { void end('others') }}>Sign out everywhere else</button></div>}
    </Section>
  )
}

function DangerZone() {
  const account = useAccount()!
  const navigate = useNavigate()
  const notify = useToast()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => { setOpen(false); setConfirm(''); setPassword(''); setError(null) }
  return (
    <Section icon={<Trash2 />} title="Delete account" tone="danger" description="Deletes your account and every course you published, with all their versions. Learners keep the copies they added. This cannot be undone.">
      <div className="form-actions start"><button type="button" className="oc-btn danger" onClick={() => setOpen(true)}><Trash2 aria-hidden />Delete my account…</button></div>
      <Dialog
        open={open}
        onClose={close}
        tone="danger"
        title="Delete your account?"
        description={<>Your account <strong>{account.username}</strong> and every course it published are deleted for good.</>}
        onSubmit={() => {
          setBusy(true); setError(null)
          api.deleteAccount(password)
            .then(() => { session.set(null); notify('Your account was deleted.', 'info'); navigate('/', { replace: true }) })
            .catch((err: unknown) => setError(message(err)))
            .finally(() => setBusy(false))
        }}
        footer={<><button type="button" className="oc-btn secondary" onClick={close}>Cancel</button><button type="submit" className="oc-btn danger-solid" disabled={busy || confirm !== account.username || !password}>Delete forever</button></>}
      >
        <FormError message={error} />
        <TextField label={`Type ${account.username} to confirm`} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Dialog>
    </Section>
  )
}
