import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Html from './Html'

export default function CourseDescription({ source }: { source: string }): JSX.Element {
  const id = useId()
  const content = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    setExpanded(false)
    const element = content.current!
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setOverflowing(element.getBoundingClientRect().height > lineHeight * 7.5 + 1)
    }
    measure()
    // Measure the full content even while its parent clips the preview. This
    // also follows wrapping, theme fonts, and images as they finish loading.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [source])

  const collapsed = overflowing && !expanded
  return <div className={`course-description${collapsed ? ' is-collapsed' : ''}`}>
    <div id={id} className="course-description-preview prose" onFocusCapture={() => setExpanded(true)}>
      <div ref={content} className="course-description-content">
        <Html className="course-description-markdown" source={source} />
      </div>
    </div>
    {overflowing && <button
      type="button"
      className="course-description-toggle"
      aria-expanded={expanded}
      aria-controls={id}
      onClick={() => setExpanded(value => !value)}
    >
      <span>{expanded ? 'Show less' : 'Show all'}</span>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} />
      </svg>
    </button>}
  </div>
}
