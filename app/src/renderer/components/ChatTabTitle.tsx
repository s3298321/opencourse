import { useLayoutEffect, useRef } from 'react'
import type { JSX } from 'react'

/** Fade in the new label while the tab smoothly grows or shrinks to fit it. */
export default function ChatTabTitle({ title }: { title: string }): JSX.Element {
  const frame = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const previous = useRef<{ title: string; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!frame.current || !text.current) return
    const width = text.current.getBoundingClientRect().width
    const before = previous.current
    previous.current = { title, width }
    if (!before || before.title === title || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timing = { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
    const resize = frame.current.animate([{ width: `${before.width}px` }, { width: `${width}px` }], timing)
    const reveal = text.current.animate([
      { opacity: 0, transform: 'translateY(4px)', filter: 'blur(2px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
    ], timing)
    return () => { resize.cancel(); reveal.cancel() }
  }, [title])
  return <span className="sidechat-tab-title" ref={frame}><span ref={text}>{title}</span></span>
}
