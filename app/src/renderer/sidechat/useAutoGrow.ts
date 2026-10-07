/**
 * A textarea as tall as what is written in it - from one line up to the
 * ceiling its CSS `max-height` sets - that eases between heights rather than
 * jumping, and only becomes scrollable once it has stopped growing.
 *
 * The height is measured on a twin: a hidden textarea with the same classes,
 * width and value, held at zero height so its scrollHeight is exactly the
 * height the text wants. Measuring the visible field instead means collapsing
 * it to `auto` first, which restarts the transition from nothing on every
 * keystroke and throws away the field's own scroll position.
 */
import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

function fit(el: HTMLTextAreaElement, twin: HTMLTextAreaElement): void {
  const wanted = twin.scrollHeight
  const ceiling = parseFloat(getComputedStyle(el).maxHeight) || Infinity
  el.style.height = `${Math.min(wanted, ceiling)}px`
  // While the height eases up to a new line the text is briefly taller than
  // the box, and a scrollbar would flash through every one of them.
  el.style.overflowY = wanted > ceiling ? 'auto' : 'hidden'
}

export function useAutoGrow(
  field: RefObject<HTMLTextAreaElement | null>,
  twin: RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useLayoutEffect(() => {
    if (field.current && twin.current) fit(field.current, twin.current)
  }, [field, twin, value])

  // Dragging the panel narrower rewraps the text without changing it. The
  // twin's height is pinned, so only a change of width reaches this.
  useLayoutEffect(() => {
    const el = field.current
    const ghost = twin.current
    if (!el || !ghost) return
    const observer = new ResizeObserver(() => fit(el, ghost))
    observer.observe(ghost)
    return () => observer.disconnect()
  }, [field, twin])
}
