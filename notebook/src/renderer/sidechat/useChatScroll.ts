import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { atBottom } from '@core/coach/scroll'

/** Follow new output until the reader moves up; returning to the bottom resumes it. */
export function useChatScroll(chatId: string | null, output: string, active: boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const followingNow = useRef(true)
  const lastTop = useRef(0)

  const follow = useCallback((next: boolean) => {
    followingNow.current = next
    setFollowing(next)
  }, [])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!active || !el) return
    // Growing output can emit a scroll event without a user moving. Only an
    // upward move releases follow, including one smaller than the usual slack.
    if (el.scrollTop < lastTop.current && !atBottom(el, 1)) follow(false)
    else if (!followingNow.current && atBottom(el, 1)) follow(true)
    lastTop.current = el.scrollTop
  }, [active, follow])

  const scrollLatest = useCallback(() => {
    const el = scroller.current
    if (!active || !el || !followingNow.current) return
    // A delta can land before the browser delivers the user's scroll event.
    if (el.scrollTop < lastTop.current && !atBottom(el, 1)) {
      lastTop.current = el.scrollTop
      follow(false)
      return
    }
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [active, follow])

  const jumpToLatest = useCallback(() => {
    const el = scroller.current
    if (!active || !el) return
    follow(true)
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [active, follow])

  useLayoutEffect(() => {
    follow(true)
    lastTop.current = scroller.current?.scrollTop ?? 0
  }, [chatId, follow])

  useLayoutEffect(() => {
    scrollLatest()
  }, [chatId, output, scrollLatest])

  useLayoutEffect(() => {
    if (!active || !scroller.current || !content.current) return
    // Both the viewport (composer/panel resizing) and the content (images,
    // markdown reflow) can grow independently of a streaming delta.
    const observer = new ResizeObserver(scrollLatest)
    observer.observe(scroller.current)
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [active, scrollLatest])

  return { scroller, content, following, onScroll, jumpToLatest }
}
