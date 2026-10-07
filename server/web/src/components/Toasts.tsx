import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'

type Tone = 'ok' | 'err' | 'info'
interface Toast { id: number; tone: Tone; text: string; leaving: boolean }
type Notify = (text: string, tone?: Tone) => void

const ToastContext = createContext<Notify>(() => {})

/** One quiet line at the bottom of the window for every finished action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 180)
  }, [])

  const notify = useCallback<Notify>((text, tone = 'ok') => {
    const id = next.current++
    setToasts((all) => [...all.slice(-3), { id, tone, text, leaving: false }])
    timers.current.set(id, window.setTimeout(() => dismiss(id), tone === 'err' ? 7000 : 4200))
  }, [dismiss])

  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer) }, [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}${toast.leaving ? ' leaving' : ''}`}>
            {toast.tone === 'err' ? <AlertCircle aria-hidden /> : <CheckCircle2 aria-hidden />}
            <span>{toast.text}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}><X aria-hidden /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = (): Notify => useContext(ToastContext)
