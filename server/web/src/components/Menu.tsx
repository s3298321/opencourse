import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: ReactNode
  icon?: ReactNode
  onSelect: () => void
  tone?: 'danger'
  disabled?: boolean
}

/**
 * A menu that floats over the page, as the app's components/Menu.tsx does:
 * rendered in a body portal and positioned `fixed` from its trigger's
 * rectangle, so no scrolling region clips it. It opens upwards when there is
 * no room below, closes on Escape, on a press outside and on scroll - except
 * a scroll inside the menu itself (scroll does not bubble, so the listener is
 * in the capture phase and sees every scroller, its own list included).
 */
export function Menu({ trigger, items, align = 'end', label, header }: {
  trigger: (props: { open: boolean; toggle: () => void; ref: (node: HTMLButtonElement | null) => void }) => ReactNode
  items: (MenuItem | 'separator')[]
  align?: 'start' | 'end'
  label: string
  header?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback((focusTrigger = false) => {
    setOpen(false)
    if (focusTrigger) triggerRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (!rect || !panel) return
      const height = panel.offsetHeight, width = panel.offsetWidth
      const up = rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - 6 - height > 8
      const left = align === 'end' ? Math.max(8, rect.right - width) : Math.min(rect.left, window.innerWidth - width - 8)
      setPosition({ top: up ? rect.top - 6 - height : rect.bottom + 6, left, up })
    }
    place()
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close()
    }
    const onScroll = (event: Event): void => {
      if (panelRef.current?.contains(event.target as Node)) return
      close()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') { event.preventDefault(); close(true) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus() }
    else if (event.key === 'Home') { event.preventDefault(); buttons[0]?.focus() }
    else if (event.key === 'End') { event.preventDefault(); buttons.at(-1)?.focus() }
    else if (event.key === 'Tab') close()
  }

  return (
    <>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: (node) => { triggerRef.current = node } })}
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          className={`menu-panel oc-popover${position?.up ? ' up' : ''}`}
          style={position ? { top: position.top, left: position.left } : { visibility: 'hidden', top: 0, left: 0 }}
          onKeyDown={onKeyDown}
        >
          {header && <div className="menu-header">{header}</div>}
          {items.map((item, i) => item === 'separator'
            ? <div key={`sep-${i}`} className="menu-separator" role="separator" />
            : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`menu-item${item.tone ? ` ${item.tone}` : ''}`}
                disabled={item.disabled}
                onClick={() => { close(); item.onSelect() }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
        </div>,
        document.body
      )}
    </>
  )
}
