import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  /** Secondary text, shown dimmed on the same row. */
  hint?: string
  /** Set on a list that picks one of several - turns the row into a radio. */
  checked?: boolean
  danger?: boolean
  onSelect: () => void
}

/**
 * The app's one popover. The user chip in the titlebar and the side chat's
 * model and reasoning pickers all want the same behaviour, so it is a
 * component rather than a pattern copied three times.
 *
 * Three details are load-bearing rather than decorative:
 *
 * - It is portalled to the document and positioned `fixed` from the trigger's
 *   rectangle. This avoids clipping and keeps animated panes from changing
 *   its coordinate system; it follows the trigger until its animation ends.
 * - It opens below its trigger when it fits and above when it does not. The
 *   side chat's pickers sit under the composer at the foot of the window,
 *   where "below" is off screen.
 * - It keeps type-ahead and a scrolling maximum height, because the model
 *   picker it replaced was a native `<select>` that had both. The list comes
 *   from OpenAI's /v1/models and is as long as that key can reach.
 */
export default function Menu({
  label,
  className,
  panelClassName,
  title,
  ariaLabel,
  'aria-describedby': ariaDescribedBy,
  disabled = false,
  align = 'right',
  items
}: {
  label: ReactNode
  className?: string
  panelClassName?: string
  title?: string
  ariaLabel?: string
  'aria-describedby'?: string
  disabled?: boolean
  /** Which edge of the trigger the panel lines up with. */
  align?: 'left' | 'right'
  items: MenuItem[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  // Letters typed in quick succession jump to a matching row, the way a native
  // select does. Reset by time, not by keystroke, so "gpt" is one search.
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 })

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }, [])

  // Measured after layout and before paint, so the panel never shows in the
  // wrong place for a frame.
  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current
    if (!button) return
    const width = panel.current?.offsetWidth ?? 0
    const height = panel.current?.offsetHeight ?? 0
    const position = (): void => {
      const box = button.getBoundingClientRect()
      const left = align === 'right' ? box.right - width : box.left
      const below = box.bottom + 4
      // Above only when below does not fit and above has more room: a long list
      // under a trigger near the top still opens downwards and scrolls.
      const flip = below + height > window.innerHeight - 8 && box.top > window.innerHeight - box.bottom
      const next = {
        top: flip ? Math.max(8, box.top - 4 - height) : below,
        // Never off the near edge of the window, whichever edge that is.
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8))
      }
      setAt((current) => current?.top === next.top && current.left === next.left ? current : next)
    }
    // A newly opened chat is sliding into place. Its portal menu follows the
    // trigger through that short animation, then stops doing frame work.
    const animations: Animation[] = []
    for (let node: HTMLElement | null = button; node; node = node.parentElement) {
      animations.push(...node.getAnimations())
    }
    let frame = 0
    const follow = (): void => {
      position()
      if (animations.some((animation) => animation.playState === 'running' || animation.pending)) {
        frame = requestAnimationFrame(follow)
      }
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [open, align, items.length])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return
      close(false)
    }
    // A menu anchored to the viewport has to go when the viewport moves under
    // it; following a scroll would be a lie about where it belongs.
    const onMove = (): void => close(false)
    // ...but the panel scrolling *itself* is not the viewport moving, it is
    // someone reading the list. Scroll does not bubble, so this listener is in
    // the capture phase and sees every scroller on the page including this one
    // - which shut the menu the moment you tried to reach the model below.
    const onScroll = (event: Event): void => {
      const target = event.target as Node | null
      if (target && panel.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  // Open on the checked row when there is one: a picker should start where it
  // is set, not at the top of a list of forty models.
  const show = (): void => {
    const checked = items.findIndex((item) => item.checked)
    setActive(checked >= 0 ? checked : 0)
    setOpen(true)
  }

  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])

  const choose = (item: MenuItem): void => {
    close()
    item.onSelect()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + items.length) % items.length)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : items.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const item = items[active]
      if (item) choose(item)
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now()
      const text = (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase()
      typed.current = { text, at: now }
      const found = items.findIndex((item) => item.label.toLowerCase().startsWith(text))
      if (found >= 0) setActive(found)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        disabled={disabled}
        className={`menu-trigger${className ? ` ${className}` : ''}${open ? ' open' : ''}`}
        {...(title ? { title } : {})}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            show()
          }
        }}
      >
        {label}
        <span className="menu-caret" aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={panel}
          className={`menu-panel${panelClassName ? ` ${panelClassName}` : ''}`}
          role="menu"
          tabIndex={-1}
          style={{ top: at?.top ?? -9999, left: at?.left ?? -9999, visibility: at ? 'visible' : 'hidden' }}
          onKeyDown={onKeyDown}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              {...(item.checked === undefined ? {} : { 'aria-checked': item.checked })}
              className={`menu-item${i === active ? ' active' : ''}${item.danger ? ' danger' : ''}${
                item.checked ? ' checked' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              {item.icon && <span className="menu-item-icon" aria-hidden="true">{item.icon}</span>}
              <span className="menu-item-label">{item.label}</span>
              {item.hint && <span className="menu-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>, document.body
      )}
    </>
  )
}
