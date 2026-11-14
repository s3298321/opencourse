import { useRef, type MouseEvent, type PointerEvent } from 'react'

/** Native dialog backdrops target the dialog itself, just like its padding. */
export function useDialogBackdropClose(onClose: () => void) {
  const startedOutside = useRef(false)
  const outside = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
  }
  return {
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => { startedOutside.current = event.button === 0 && outside(event) },
    onPointerCancel: () => { startedOutside.current = false },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      const dismiss = startedOutside.current && outside(event)
      startedOutside.current = false
      if (dismiss) onClose()
    }
  }
}
