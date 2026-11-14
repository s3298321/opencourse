import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const OPENED = 'opencourse:floating-surface-opened'

/** One mounted surface morphs between the launcher button and its contents. */
export default function FloatingSurface({ name, label, open, onOpenChange, icon, children, active = false, activityLevel = 0 }: {
  name: string; label: string; open: boolean; onOpenChange: (value: boolean) => void; activityLevel?: number
  icon: ReactNode; children: ReactNode; active?: boolean
}) {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const [height, setHeight] = useState(56)
  const change = useRef(onOpenChange)
  change.current = onOpenChange
  useLayoutEffect(() => {
    const element = panel.current!
    const measure = () => setHeight(element.getBoundingClientRect().height + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== name) change.current(false) }
    window.addEventListener(OPENED, other)
    return () => window.removeEventListener(OPENED, other)
  }, [name])
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent(OPENED, { detail: name }))
    const focus = panel.current?.querySelector<HTMLElement>('input[type=search]') ?? panel.current?.querySelector<HTMLElement>('button')
    focus?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('[role="dialog"]')) change.current(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, name])
  const close = () => { onOpenChange(false); trigger.current?.focus() }
  return <div ref={root} className={`writing-launcher ${name}-floating${open ? ' expanded' : ''}${active ? ' conversation-active' : ''}`} style={{ height: open ? height : 56, '--floating-audio-level': active && Number.isFinite(activityLevel) ? Math.max(0, Math.min(1, activityLevel)) : 0 } as CSSProperties} onKeyDown={event => {
    if (open && event.key === 'Escape') { event.stopPropagation(); close() }
    if (open && ['ArrowDown', 'ArrowUp'].includes(event.key) && ((event.target as HTMLElement).matches('input[type=search]') || (event.target as HTMLElement).closest('.writing-launcher-results'))) {
      const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('.writing-launcher-results button:not(:disabled):not([inert] *)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1)
      if (buttons[next]) { event.preventDefault(); buttons[next].focus() }
    }
  }}>
    <div ref={panel} className="writing-launcher-panel" role="region" aria-label={label} inert={!open} aria-hidden={!open}>
      <header><strong>{label}</strong><button className="writing-launcher-close" aria-label={`Collapse ${label.toLowerCase()}`} onClick={close}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
      {children}
    </div>
    <button ref={trigger} className="writing-launcher-toggle" title={active ? `${label} — conversation active` : label} aria-label={active ? `${label} (conversation active)` : label} aria-expanded={open} aria-hidden={open} tabIndex={open ? -1 : 0} onClick={() => onOpenChange(true)}>{icon}</button>
  </div>
}
