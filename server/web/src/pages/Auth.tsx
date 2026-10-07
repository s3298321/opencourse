import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Mail } from 'lucide-react'
import { CODE_LENGTH, emailProblem, isCode, passwordProblem, usernameProblem } from '@core/catalog/api'
import { api, ApiError } from '../lib/api'
import { server } from '../lib/boot'
import { safeNext, session, useAccount } from '../lib/session'
import { CodeInput, FormError, PasswordField, TextField } from '../components/Forms'
import { Sparkles } from '../components/Brand'
import { useToast } from '../components/Toasts'
import { useTitle } from '../components/Bits'

const message = (error: unknown): string => (error instanceof ApiError ? error.message : 'Something went wrong. Try again.')

function AuthCard({ title, subtitle, children, footer, steps }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; steps?: { labels: string[]; at: number } }) {
  return (
    <div className="auth">
      <div className="oc-aurora" aria-hidden="true" />
      <Sparkles count={6} className="auth-sparkles" />
      <div className="auth-card oc-popover oc-edge oc-enter">
        <img className="auth-mark" src="/mark-128.png" alt="" width={52} height={52} />
        {steps && (
          <ol className="auth-steps" aria-label="Steps">
            {steps.labels.map((label, i) => (
              <li key={label} className={i < steps.at ? 'done' : i === steps.at ? 'now' : ''} aria-current={i === steps.at ? 'step' : undefined}>
                <span className="auth-step-dot">{i < steps.at ? <Check aria-hidden /> : i + 1}</span>{label}
              </li>
            ))}
          </ol>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </div>
  )
}

/** A resend link that waits a minute between sends, as the server's own limit would. */
function Resend({ onResend }: { onResend: () => Promise<void> }) {
  const [wait, setWait] = useState(60)
  useEffect(() => {
    if (wait <= 0) return
    const timer = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [wait])
  return wait > 0
    ? <span className="resend muted">Send a new code in {wait}s</span>
    : <button type="button" className="link-button" onClick={() => { void onResend().then(() => setWait(60)) }}>Send a new code</button>
}

export function SignInPage() {
  useTitle('Sign in')
  const account = useAccount()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const notify = useToast()
  const next = safeNext(params.get('next'))
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (account && !busy) return <Navigate to={next} replace />

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const result = await api.login(login.trim(), password)
      session.set(result.account)
      notify(`Welcome back, ${result.account.username}.`)
      navigate(next, { replace: true, viewTransition: true })
    } catch (err) {
      setError(message(err)); setBusy(false)
    }
  }
  return (
    <AuthCard
      title="Sign in"
      subtitle={<>to {server.name}</>}
      footer={server.registration === 'open' ? <>New here? <Link to={`/signup${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} viewTransition>Create an account</Link></> : <>This server is not accepting new accounts.</>}
    >
      <form className="auth-form" onSubmit={submit}>
        <FormError message={error} />
        <TextField label="Email or username" name="username" autoComplete="username" autoFocus required value={login} onChange={(e) => setLogin(e.target.value)} />
        <PasswordField label="Password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Link className="forgot-link" to="/forgot" viewTransition>Forgot password?</Link>
        <button type="submit" className="oc-btn lg block" disabled={busy || !login.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </AuthCard>
  )
}

export function SignUpPage() {
  useTitle('Create an account')
  const account = useAccount()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const notify = useToast()
  const next = safeNext(params.get('next'))
  const [step, setStep] = useState<'email' | 'code' | 'details'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [ticket, setTicket] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [nameState, setNameState] = useState<{ name: string; ok: boolean; reason?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The name is checked as it is typed, against the same rules the server applies.
  useEffect(() => {
    if (step !== 'details' || !username) { setNameState(null); return }
    const local = usernameProblem(username)
    if (local) { setNameState({ name: username, ok: false, reason: local }); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api.usernameAvailable(username, controller.signal)
        .then((r) => setNameState({ name: username, ok: r.available, reason: r.reason }))
        .catch(() => {})
    }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [username, step])

  if (account && !busy) return <Navigate to={next} replace />
  if (server.registration !== 'open') {
    return <AuthCard title="Not accepting accounts" subtitle={<>{server.name} is not taking new accounts right now.</>} footer={<Link to="/signin" viewTransition>Sign in instead</Link>}><span /></AuthCard>
  }

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await work() } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }
  const sendCode = (): Promise<void> => api.registerStart(email.trim()).then(() => undefined)

  if (step === 'email') {
    const problem = email.trim() ? emailProblem(email.trim()) : null
    return (
      <AuthCard title="Create your account" subtitle={<>on {server.name}. It takes a minute.</>} steps={{ labels: ['Email', 'Code', 'Account'], at: 0 }} footer={<>Already have one? <Link to="/signin" viewTransition>Sign in</Link></>}>
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await sendCode(); setStep('code') }) }}>
          <FormError message={error} />
          <TextField label="Email" type="email" name="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} error={problem} hint="We send a 6-digit code to confirm it. Nothing else." />
          <button type="submit" className="oc-btn lg block" disabled={busy || !email.trim() || Boolean(problem)}>{busy ? 'Sending…' : <>Continue<ArrowRight aria-hidden /></>}</button>
        </form>
      </AuthCard>
    )
  }

  if (step === 'code') {
    return (
      <AuthCard title="Check your email" subtitle={<>We sent a code to <strong>{email.trim()}</strong>. If that address already has an account, the email says so instead.</>} steps={{ labels: ['Email', 'Code', 'Account'], at: 1 }}>
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api.registerVerify(email.trim(), code); setTicket(r.ticket); setStep('details') }) }}>
          <FormError message={error} />
          <div className="code-row"><Mail aria-hidden className="code-icon" /><CodeInput value={code} onChange={(c) => { setCode(c); setError(null) }} autoFocus invalid={Boolean(error)} disabled={busy} /></div>
          <button type="submit" className="oc-btn lg block" disabled={busy || !isCode(code)}>{busy ? 'Checking…' : 'Confirm'}</button>
          <div className="auth-row">
            <button type="button" className="link-button" onClick={() => { setStep('email'); setCode(''); setError(null) }}><ArrowLeft aria-hidden />Different address</button>
            <Resend onResend={() => run(sendCode)} />
          </div>
        </form>
      </AuthCard>
    )
  }

  const passwordIssue = password ? passwordProblem(password) : null
  const ready = nameState?.ok && nameState.name === username && !passwordIssue && password.length > 0
  return (
    <AuthCard title="Choose your name" subtitle="This is how you appear as a publisher. You can sign in with it or with your email." steps={{ labels: ['Email', 'Code', 'Account'], at: 2 }}>
      <form className="auth-form" onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          const r = await api.registerComplete(ticket, username, password)
          session.set(r.account)
          notify(`Welcome to ${server.name}, ${r.account.username}.`)
          navigate(next, { replace: true, viewTransition: true })
        })
      }}>
        <FormError message={error} />
        <TextField
          label="Username" name="username" autoComplete="username" autoFocus required value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          error={nameState && nameState.name === username && !nameState.ok ? nameState.reason ?? 'That name is taken.' : null}
          hint={nameState?.ok && nameState.name === username ? <span className="ok-text"><Check aria-hidden />Available</span> : 'Lowercase letters, digits, - and _.'}
        />
        <PasswordField label="Password" name="new-password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={passwordIssue} hint={<PasswordStrength password={password} />} />
        <button type="submit" className="oc-btn lg block" disabled={busy || !ready}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </AuthCard>
  )
}

/** Length is most of what makes a password strong; the meter says so and nothing more. */
export function PasswordStrength({ password }: { password: string }) {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((r) => r.test(password)).length
  const score = password.length === 0 ? 0 : password.length < 8 ? 1 : password.length < 12 ? (kinds >= 3 ? 3 : 2) : password.length < 16 ? 3 + (kinds >= 2 ? 1 : 0) : 4
  const words = ['At least 8 characters.', 'Too short.', 'Okay - longer is stronger.', 'Good.', 'Strong.']
  return (
    <span className="strength">
      <span className={`strength-bar s${score}`} aria-hidden="true"><span /><span /><span /><span /></span>
      <span>{words[score]}</span>
    </span>
  )
}

export function ForgotPage() {
  useTitle('Reset your password')
  const account = useAccount()
  const navigate = useNavigate()
  const notify = useToast()
  const [step, setStep] = useState<'email' | 'reset'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (account && !busy) return <Navigate to="/settings" replace />

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await work() } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }

  if (step === 'email') {
    return (
      <AuthCard title="Reset your password" subtitle="We email you a code. Every other place you are signed in will be signed out." footer={<Link to="/signin" viewTransition><ArrowLeft aria-hidden />Back to sign in</Link>}>
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.forgot(email.trim()); setStep('reset') }) }}>
          <FormError message={error} />
          <TextField label="Email" type="email" name="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="oc-btn lg block" disabled={busy || !email.trim() || Boolean(emailProblem(email.trim()))}>{busy ? 'Sending…' : 'Send the code'}</button>
        </form>
      </AuthCard>
    )
  }
  const passwordIssue = password ? passwordProblem(password) : null
  return (
    <AuthCard title="Choose a new password" subtitle={<>If <strong>{email.trim()}</strong> has an account here, a code is on its way.</>}>
      <form className="auth-form" onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          const r = await api.reset(email.trim(), code, password)
          session.set(r.account)
          notify('Your password was changed.')
          navigate('/', { replace: true, viewTransition: true })
        })
      }}>
        <FormError message={error} />
        <div className="oc-field"><span className="oc-label">Code from the email</span><CodeInput value={code} onChange={setCode} autoFocus disabled={busy} /></div>
        <PasswordField label="New password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={passwordIssue} hint={<PasswordStrength password={password} />} />
        <button type="submit" className="oc-btn lg block" disabled={busy || code.length !== CODE_LENGTH || !password || Boolean(passwordIssue)}>{busy ? 'Saving…' : 'Set the new password'}</button>
        <div className="auth-row"><button type="button" className="link-button" onClick={() => setStep('email')}><ArrowLeft aria-hidden />Different address</button><Resend onResend={() => api.forgot(email.trim()).then(() => undefined)} /></div>
      </form>
    </AuthCard>
  )
}
