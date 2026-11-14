import { useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'

const MIN_OUTLINE = 170
const DEFAULT_OUTLINE = 210
const MIN_FORM = 340
const MIN_PREVIEW = 280
const MIN_CHAT = 320
const DIVIDER = 1

type Pane = 'outline' | 'preview' | 'chat'
type Widths = Partial<Record<Pane, number>>

function readWidths(key: string): Widths {
  const widths: Widths = {}
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
    for (const pane of ['outline', 'preview', 'chat'] as const) {
      if (Number.isFinite(saved?.[pane]) && saved[pane] > 0) widths[pane] = saved[pane]
    }
  } catch { /* Storage is optional. */ }
  return widths
}

function clamp(width: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.round(width), max))
}

function paneSizes(width: number, widths: Widths, outline: number, outlineLimit: number, ai: boolean, stacked = false) {
  const centerMin = ai ? MIN_PREVIEW : MIN_FORM
  const rightMin = ai ? MIN_CHAT : MIN_PREVIEW
  const room = width - (stacked ? 1 : 2) * DIVIDER
  const rightMax = Math.max(rightMin, room - outline - centerMin)
  const defaultRight = ai ? 420 : (room - DEFAULT_OUTLINE) * 0.85 / 1.85
  const right = clamp((ai ? widths.chat : widths.preview) ?? defaultRight, rightMin, rightMax)
  const center = Math.max(centerMin, room - outline - right)
  const outlineMax = stacked ? outlineLimit : Math.min(outlineLimit, Math.max(outline, room - right - centerMin))
  return { outlineMax, center, right, rightMin, rightMax }
}

// Only the mode progresses over time. Dragging a divider updates its endpoint immediately.
function modeTrack(manual: number, ai: number): string {
  return `calc(${manual}px + ${ai - manual}px * var(--author-mode-progress))`
}

function PaneDivider({ pane, width, min, max, resize }: {
  pane: Pane; width: number; min: number; max: number
  resize: (width: number, save: boolean) => void
}): JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const direction = pane === 'outline' ? 1 : -1
  const move = (x: number, save: boolean): void => {
    if (!drag.current || (x === drag.current.x && width === drag.current.width)) return
    resize(clamp(drag.current.width + (x - drag.current.x) * direction, min, max), save)
  }

  return <div className={`author-divider ${pane === 'outline' ? 'outline-divider' : 'right-divider'}`}
    role="separator" aria-orientation="vertical" aria-label={`Resize ${pane}`} aria-controls={`author-${pane}`} tabIndex={0}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width }
    }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX, false) }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX, true) }}
    onPointerCancel={() => { if (drag.current && width !== drag.current.width) resize(width, true) }}
    onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => {
      const step = (event.shiftKey ? 50 : 10) * direction
      const values: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step, Home: min, End: max }
      if (!Object.hasOwn(values, event.key)) return
      event.preventDefault()
      resize(clamp(values[event.key]!, min, max), true)
    }} />
}

export default function CourseEditorLayout({ mode, userId, children }: {
  mode: 'manual' | 'ai'; userId: string; children: ReactNode
}): JSX.Element {
  const key = `authoring:${userId}:pane-widths`
  const [widths, setWidths] = useState(() => readWidths(key))
  const layout = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(window.innerWidth)
  useLayoutEffect(() => {
    const element = layout.current!
    const measure = (): void => { if (element.clientWidth) setWidth(element.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const ai = mode === 'ai'
  const narrow = width <= 850
  const outlineLimit = Math.max(MIN_OUTLINE, narrow ? width - DIVIDER - MIN_CHAT : width - 2 * DIVIDER - MIN_FORM - MIN_PREVIEW)
  const outline = clamp(widths.outline ?? DEFAULT_OUTLINE, MIN_OUTLINE, outlineLimit)
  const manual = paneSizes(width, widths, outline, outlineLimit, false)
  const assistant = paneSizes(width, widths, outline, outlineLimit, true, narrow)
  const sizes = ai ? assistant : manual
  const rightPane = ai ? 'chat' : 'preview'
  const resize = (pane: Pane, value: number, save: boolean): void => {
    const next = { ...widths, [pane]: value }
    setWidths(next)
    if (save) {
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* Storage is optional. */ }
    }
  }
  const columns = [
    `${outline}px`, `${DIVIDER}px`,
    modeTrack(manual.center, 0), modeTrack(DIVIDER, 0),
    `minmax(${modeTrack(MIN_PREVIEW, narrow ? MIN_CHAT : MIN_PREVIEW)}, 1fr)`
  ]
  if (!narrow) columns.push(modeTrack(0, DIVIDER), modeTrack(0, assistant.right))

  return <div ref={layout} className="author-layout" style={{ gridTemplateColumns: columns.join(' ') }} data-narrow={narrow || undefined}>
    {children}
    <PaneDivider pane="outline" min={MIN_OUTLINE} width={outline} max={sizes.outlineMax}
      resize={(value, save) => resize('outline', value, save)} />
    {!(ai && narrow) && <PaneDivider key={rightPane} pane={rightPane} min={sizes.rightMin} max={sizes.rightMax} width={sizes.right}
      resize={(value, save) => resize(rightPane, value, save)} />}
  </div>
}
