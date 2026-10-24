import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import ActionButton, { type ActionIcon } from './ActionButton'
import { useActiveTheme } from '../theme/ThemeProvider'
import { WHITE_THEME_ID } from '@core/theme/builtin-ids'

export interface ConfirmRequest {
  title: string
  detail: string
  confirmLabel: string
  cancelLabel: string
  confirmIcon?: ActionIcon
  cancelIcon?: ActionIcon
  /** The confirming choice loses something - discarding edits. */
  danger?: boolean
}

/**
 * An in-app question with two answers. Used where a native `confirm()` would
 * do, but the answer has to be clickable by smoke and readable by a screen
 * reader: leaving an editor with unsaved changes, opening a downloaded course
 * in the editor. Escape is always the cancelling answer, which is also where
 * focus starts - the safe choice is the one a stray Enter takes.
 */
export default function ConfirmDialog({ request, onResult }: { request: ConfirmRequest; onResult: (confirmed: boolean) => void }): JSX.Element {
  const theme = useActiveTheme()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onResult(false) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onResult])
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-detail">
        <h2 id="dialog-title">{request.title}</h2>
        <p id="dialog-detail">{request.detail}</p>
        <div className="actions">
          <ActionButton ref={cancel} icon={request.cancelIcon ?? 'close'} className="secondary dialog-cancel" onClick={() => onResult(false)}>{request.cancelLabel}</ActionButton>
          <ActionButton icon={request.confirmIcon ?? 'check'} className={`dialog-confirm${request.danger ? ' danger' : ''}`} data-builtin-theme={theme.id === null || theme.id === WHITE_THEME_ID ? '' : undefined} onClick={() => onResult(true)}>{request.confirmLabel}</ActionButton>
        </div>
      </div>
    </div>
  )
}
