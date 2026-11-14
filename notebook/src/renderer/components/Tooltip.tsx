import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactElement } from 'react'
import { createPortal } from 'react-dom'

/** App-rendered tooltips stay visible above scrolling panes and work with keyboard focus. */
export default function Tooltip({ label, children }: {
  label: string
  children: ReactElement
}): JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focused = useRef(false)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const child = children as ReactElement<{ 'aria-describedby'?: string }>
  const hide = (): void => { clearTimeout(timer.current); setOpen(false) }
  const show = (): void => {
    document.dispatchEvent(new CustomEvent('opencourse:tooltip', { detail: id }))
    setOpen(true)
  }

  useEffect(() => {
    const onShow = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) { clearTimeout(timer.current); setOpen(false) }
    }
    document.addEventListener('opencourse:tooltip', onShow)
    return () => { clearTimeout(timer.current); document.removeEventListener('opencourse:tooltip', onShow) }
  }, [id])
  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return
    const box = trigger.current.getBoundingClientRect()
    const { width, height } = bubble.current.getBoundingClientRect()
    const above = box.top - height - 8
    setAt({
      top: Math.max(8, Math.min(above >= 8 ? above : box.bottom + 8, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(box.left + (box.width - width) / 2, window.innerWidth - width - 8))
    })
  }, [open, label])
  useEffect(() => {
    if (!open) return
    const dismiss = (): void => setOpen(false)
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') dismiss() }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  return <span className="tooltip-trigger" ref={trigger}
    onPointerEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(show, 150) }}
    onPointerLeave={() => { clearTimeout(timer.current); if (!focused.current) setOpen(false) }}
    onFocusCapture={() => { clearTimeout(timer.current); focused.current = true; show() }}
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && trigger.current?.contains(event.relatedTarget)) return
      focused.current = false; hide()
    }}
    onClickCapture={hide}>
    {cloneElement(child, { 'aria-describedby': open ? id : child.props['aria-describedby'] })}
    {open && createPortal(<div className="tooltip" role="tooltip" id={id} ref={bubble}
      style={{ top: at?.top ?? 0, left: at?.left ?? 0, visibility: at ? 'visible' : 'hidden' }}>{label}</div>, document.body)}
  </span>
}
