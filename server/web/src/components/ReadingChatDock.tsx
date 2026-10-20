import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ReadingCitation } from '../../../../app/src/learning-ui/ReadingMessage'
import type { ContentRef } from '@core/learning/types'
import { ReadingChat } from '../../../../app/src/learning-ui/ReadingChat'
import { ChatIcon } from '../../../../app/src/learning-ui/ChatIcon'
import { learningClient } from '../lib/learning'
import { Html } from './Html'
import { renderMarkdown } from '../lib/markdown'

export function ReadingChatDock({
  open,
  onOpenChange,
  source,
  draftKey,
  quote,
  onQuoteUsed,
  onSource
}: {
  onSource?: (source: ReadingCitation) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  source: ContentRef
  draftKey: string
  quote: string
  onQuoteUsed: () => void
}) {
  const rail = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  // Fill the visible viewport below the site header, including when the mobile
  // keyboard changes its height. The card is independent of transcript length.
  // Near the end of the page it stops level with the reader's lower edge - the
  // document's card, or the lesson and the outline beside it - and gets shorter,
  // rather than hanging down over the footer.
  useLayoutEffect(() => {
    const element = rail.current
    if (!element) return
    let frame = 0
    const readerBottom = () => {
      const layout = element.parentElement
      if (!layout) return Infinity
      const edges = [...layout.querySelectorAll(':scope > .web-reader-column, :scope > .course-reading-outline')].map(
        (e) => e.getBoundingClientRect().bottom
      )
      return edges.length ? Math.max(...edges) : Infinity
    }
    const measure = () => {
      const viewport = window.visualViewport
      const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight
      // The room is measured to 16px above `bottom`, so the reader's edge counts 16px lower.
      const bottom = Math.min(visibleBottom, readerBottom() + 16)
      const headerBottom = document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 60
      const top = Math.max(headerBottom, viewport?.offsetTop ?? 0) + 16
      const bounds = element.getBoundingClientRect()
      const gutter = parseFloat(getComputedStyle(element.closest('.learning-page')!).paddingRight)
      const width = Math.min(360, window.innerWidth - 2 * gutter)
      const left = Math.min(bounds.left, window.innerWidth - width - gutter)
      // The closed footprint matches the launcher, even when a narrow viewport
      // makes the expanded card extend to its left. ResizeObserver follows the
      // rail while the reading columns animate.
      const iconLeft = bounds.left
      element.style.setProperty('--reading-chat-left', `${left}px`)
      element.style.setProperty('--chat-origin-x', `${iconLeft - left}px`)
      element.style.setProperty('--chat-origin-y', `${Math.max(0, bounds.top - top)}px`)
      element.style.setProperty('--reading-chat-top', `${top}px`)
      element.style.setProperty('--reading-chat-room', `${Math.max(180, bottom - top - 16)}px`)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [])
  const [initialized, setInitialized] = useState(open)
  useEffect(() => {
    if (open) setInitialized(true)
    else if (initialized) launcher.current?.focus({ preventScroll: true })
  }, [open, initialized])
  function close() {
    onOpenChange(false)
  }
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onOpenChange(false)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open, onOpenChange])
  return (
    <div className="reading-chat-rail" ref={rail}>
      <button
        ref={launcher}
        className="reading-chat-launcher"
        type="button"
        hidden={open}
        aria-label="Open reading chat"
        title="Ask about this"
        aria-expanded={open}
        aria-controls="reading-chat-panel"
        onClick={() => onOpenChange(true)}
      >
        <ChatIcon size={21} />
      </button>
      <div id="reading-chat-panel" className="reading-chat-reveal" inert={!open} aria-hidden={!open}>
        {initialized && (
          <ReadingChat
            client={learningClient}
            source={source}
            onSource={onSource}
            draftKey={draftKey}
            quote={quote}
            onQuoteUsed={onQuoteUsed}
            visible={open}
            onClose={close}
            settingsLink={<Link to="/settings">Open Settings</Link>}
            renderAnswer={(text) => <Html className="oc-prose" html={renderMarkdown(text)} />}
          />
        )}
      </div>
    </div>
  )
}
