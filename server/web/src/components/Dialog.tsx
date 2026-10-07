import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * A modal on the native <dialog>: the browser traps focus, makes the page
 * behind it inert and closes it on Escape. It is opened by being rendered with
 * `open`, and plays a short exit before it unmounts.
 */
export function Dialog({ open, onClose, title, description, children, footer, wide, onSubmit, tone }: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
  tone?: 'danger'
  /** Makes the dialog a form; its footer's submit button submits it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setClosing(false)
      dialog.showModal()
      // showModal focuses the first focusable thing, the close button; a dialog
      // that asks for something should start in its first field instead.
      dialog.querySelector<HTMLElement>('.dialog-body input:not([type=hidden]), .dialog-body textarea, .dialog-body select')?.focus()
    }
    if (!open && dialog.open) {
      setClosing(true)
      const timer = window.setTimeout(() => { dialog.close(); setClosing(false) }, 140)
      return () => window.clearTimeout(timer)
    }
  }, [open])

  const body = (
    <>
      <header className="dialog-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p className="dialog-description">{description}</p>}
        </div>
        <button type="button" className="oc-btn ghost icon dialog-x" aria-label="Close" onClick={onClose}><X aria-hidden /></button>
      </header>
      {children && <div className="dialog-body">{children}</div>}
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </>
  )

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' wide' : ''}${closing ? ' closing' : ''}${tone ? ` ${tone}` : ''}`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === ref.current) onClose() }}
      aria-labelledby={titleId}
    >
      {open || closing ? (onSubmit ? <form onSubmit={(event) => { event.preventDefault(); onSubmit(event) }}>{body}</form> : <div>{body}</div>) : null}
    </dialog>
  )
}
