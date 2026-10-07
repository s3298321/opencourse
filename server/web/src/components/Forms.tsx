import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { AlertCircle, Check, Copy, Eye, EyeOff } from 'lucide-react'
import { CODE_LENGTH } from '@core/catalog/api'

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="oc-field">
      <label className="oc-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="oc-error-text" role="alert">{error}</span> : hint ? <span className="oc-hint">{hint}</span> : null}
    </div>
  )
}

export function TextField({ label, hint, error, ...input }: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input id={id} className="oc-input" aria-invalid={error ? true : undefined} {...input} />
    </Field>
  )
}

/** A password box with a show/hide toggle - typing a new password blind is how typos get locked in. */
export function PasswordField({ label, hint, error, ...input }: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <div className="password-input">
        <input id={id} className="oc-input" type={shown ? 'text' : 'password'} aria-invalid={error ? true : undefined} {...input} />
        <button type="button" className="password-toggle" aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown((v) => !v)}>
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </button>
      </div>
    </Field>
  )
}

/** Six boxes for the emailed code. Typing moves along; pasting the whole code fills them all. */
export function CodeInput({ value, onChange, disabled, autoFocus, invalid }: { value: string; onChange: (code: string) => void; disabled?: boolean; autoFocus?: boolean; invalid?: boolean }) {
  const boxes = useRef<(HTMLInputElement | null)[]>([])
  useEffect(() => { if (autoFocus) boxes.current[0]?.focus() }, [autoFocus])
  const digits = value.padEnd(CODE_LENGTH, ' ').slice(0, CODE_LENGTH).split('')
  const set = (index: number, text: string): void => {
    const clean = text.replace(/\D/g, '')
    if (!clean) return
    const next = (value.slice(0, index) + clean).slice(0, CODE_LENGTH)
    onChange(next)
    boxes.current[Math.min(next.length, CODE_LENGTH - 1)]?.focus()
  }
  return (
    <div className={`code-input${invalid ? ' invalid' : ''}`} role="group" aria-label="Code from the email">
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(node) => { boxes.current[i] = node }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          maxLength={CODE_LENGTH}
          disabled={disabled}
          value={digit.trim()}
          onChange={(event) => set(i, event.target.value)}
          onPaste={(event) => { event.preventDefault(); set(0, event.clipboardData.getData('text')) }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              event.preventDefault()
              const at = digit.trim() ? i : Math.max(0, i - 1)
              onChange(value.slice(0, at))
              boxes.current[at]?.focus()
            } else if (event.key === 'ArrowLeft') boxes.current[i - 1]?.focus()
            else if (event.key === 'ArrowRight') boxes.current[i + 1]?.focus()
          }}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return <div className="form-error" role="alert"><AlertCircle aria-hidden /><span>{message}</span></div>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button type="button" className={`oc-btn secondary sm copy-button${copied ? ' copied' : ''}`} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)) }}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  )
}
