import { memo, createElement, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { markGeometry, sketchSvg, MIN_SKETCH_SIZE, MAX_SKETCH_SIZE, type MarkKind, type Point, type Sketch, type SketchColors, type SketchMark } from '@core/writing-notebooks/sketch'
import { eraseSketchMarks } from '@core/writing-notebooks/sketch-eraser'
import { Icon, type ActionIcon } from '../components/ActionButton'
import { onThemeApplied } from '../theme/events'
import { currentSketchColors, type SketchAssets } from './sketch-assets'

type Tool = MarkKind | 'eraser'
const tools: [Tool, string, ActionIcon][] = [['brush', 'Brush', 'edit'], ['rectangle', 'Rectangle', 'rectangle'], ['circle', 'Circle', 'circle'], ['arrow', 'Arrow', 'diagonalArrow'], ['eraser', 'Eraser', 'eraser']]
export interface SketchHistory { undo: string[]; redo: string[] }
interface Props {
  history: SketchHistory
  asset: string; assets: SketchAssets; active: boolean; open: () => void; exit: () => void
  currentAsset: () => string | undefined; replace: (expected: string, next: string) => boolean; measure: () => void; save: () => void
}
interface Drag {
  id: number
  update: (x: number, y: number, samples?: PointerEvent[]) => void
  complete: (released: boolean) => void
}
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const round = (n: number) => Math.round(n * 10) / 10

function eraserCursor(diameter: number, colors: SketchColors): string {
  const center = Math.ceil(diameter / 2) + 2
  const rim = Math.min(1, diameter / 2)
  const circle = `cx="${center}" cy="${center}" r="${(diameter - rim) / 2}"`
  // The ink ring's outer edge is the eraser footprint. A contrasting halo keeps it visible over drawn marks.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${center * 2}" height="${center * 2}" fill="none">` +
    `<circle ${circle} stroke="${colors.background}" stroke-width="${rim + 1.5}"/>` +
    `<circle ${circle} stroke="${colors.brush}" stroke-width="${rim}"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`
}

const Mark = memo(function Mark({ mark, index }: { mark: SketchMark; index?: number }) {
  const { element, attributes } = markGeometry(mark)
  return createElement(element, { ...attributes, strokeWidth: mark.width, 'data-mark': index })
})

export function SketchCanvas({ asset, assets, active, open, exit, currentAsset, replace, measure, save, history }: Props) {
  const displayedAsset = (active && currentAsset()) || asset
  const cached = assets.cached(displayedAsset)
  const [loaded, setLoaded] = useState<{ asset: string; error?: string }>()
  const [tool, setTool] = useState<Tool>('brush'), [width, setWidth] = useState(3)
  const [colors, setColors] = useState(currentSketchColors)
  const [preview, setPreview] = useState<Sketch | null>(null)
  const [eraserTrace, setEraserTrace] = useState<SketchMark | null>(null)
  const drag = useRef<Drag | null>(null), frame = useRef<HTMLSpanElement>(null)
  const surface = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (cached) return
    let live = true
    void assets.load(displayedAsset).then(() => { if (live) setLoaded({ asset: displayedAsset }) }, () => {
      if (live) setLoaded({ asset: displayedAsset, error: 'Sketch could not be opened.' })
    })
    return () => { live = false }
  }, [displayedAsset, assets, cached])
  useLayoutEffect(() => {
    const refresh = () => setColors(currentSketchColors())
    const media = ['(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)'].map(query => window.matchMedia?.(query))
    for (const query of media) query?.addEventListener('change', refresh)
    const off = onThemeApplied(refresh)
    refresh()
    return () => { off(); for (const query of media) query?.removeEventListener('change', refresh) }
  }, [])
  useLayoutEffect(() => { if (active) frame.current?.focus({ preventScroll: true }) }, [active])
  const model = preview ?? cached
  const canvasWidth = model?.width
  useLayoutEffect(() => {
    const drawing = surface.current, canvas = frame.current
    if (!active || tool !== 'eraser' || !drawing || !canvas || !canvasWidth) return
    const refresh = () => {
      const diameter = width * drawing.getBoundingClientRect().width / canvasWidth
      drawing.style.cursor = diameter > 0 ? eraserCursor(diameter, colors) : ''
    }
    refresh()
    const observer = new ResizeObserver(refresh)
    observer.observe(canvas)
    return () => { observer.disconnect(); drawing.style.removeProperty('cursor') }
  }, [active, tool, width, canvasWidth, colors])
  useLayoutEffect(() => { measure() }, [model?.width, model?.height, loaded?.error, active, measure])
  function commit(base: string, next: Sketch) {
    if (currentAsset() !== base) return
    if (replace(base, assets.stage(next))) {
      history.undo.push(base)
      history.redo = []
    }
  }
  function step(direction: 'undo' | 'redo') {
    const base = currentAsset(), target = history[direction].at(-1)
    if (base && target && replace(base, target)) {
      history[direction].pop()
      history[direction === 'undo' ? 'redo' : 'undo'].push(base)
    }
  }
  function begin(event: ReactPointerEvent<SVGSVGElement | HTMLButtonElement>, resizing: boolean) {
    // CodeMirror updates the link synchronously. The canvas props can still be rendering the previous stroke.
    const base = currentAsset(), original = base && assets.cached(base)
    if (!base || !original || event.button !== 0 || drag.current) return
    event.preventDefault()
    frame.current?.focus({ preventScroll: true })
    const erasing = !resizing && tool === 'eraser'
    const rect = frame.current!.getBoundingClientRect(), scale = original.width / rect.width
    const point = (x: number, y: number): Point => [round(clamp((x - rect.left) * scale, 0, original.width)), round(clamp((y - rect.top) * scale, 0, original.height))]
    const x0 = event.clientX, y0 = event.clientY, start = point(x0, y0)
    const points = [start]
    let latest = original
    const update = (x: number, y: number, samples: PointerEvent[] = []) => {
      if (resizing) {
        const size = (n: number) => clamp(Math.round(n), MIN_SKETCH_SIZE, MAX_SKETCH_SIZE)
        latest = { ...original, width: size(original.width + (x - x0) * scale), height: size(original.height + (y - y0) * scale) }
        setPreview(latest)
        return
      }
      const end = point(x, y)
      if (tool === 'brush' || erasing) {
        const append = (p: Point) => {
          const last = points.at(-1)!
          if (p[0] !== last[0] || p[1] !== last[1]) points.push(p)
        }
        for (const sample of samples) append(point(sample.clientX, sample.clientY))
        append(end)
      }
      if (erasing) {
        setEraserTrace({ kind: 'brush', width, points })
        return
      }
      const mark: SketchMark = { kind: tool as MarkKind, width, points: tool === 'brush' ? points : [start, end] }
      latest = { ...original, marks: [...original.marks, mark] }
      setPreview(latest)
    }
    const complete = (released: boolean) => {
      if (erasing && released) latest = eraseSketchMarks(original, points, width)
      if (latest !== original) commit(base, latest)
      setPreview(null)
      setEraserTrace(null)
    }
    drag.current = { id: event.pointerId, update, complete }
    event.currentTarget.setPointerCapture(event.pointerId)
    update(x0, y0)
  }
  function finish(pointerId: number, end?: ReactPointerEvent) {
    const gesture = drag.current
    if (!gesture || gesture.id !== pointerId) return
    drag.current = null
    if (end) gesture.update(end.clientX, end.clientY)
    gesture.complete(!!end)
  }
  const pointer = {
    onPointerMove(event: ReactPointerEvent) {
      const gesture = drag.current
      if (!gesture || gesture.id !== event.pointerId) return
      gesture.update(event.clientX, event.clientY, event.nativeEvent.getCoalescedEvents?.())
    },
    onPointerUp(event: ReactPointerEvent) { finish(event.pointerId, event) },
    onPointerCancel(event: ReactPointerEvent) { finish(event.pointerId) },
    onLostPointerCapture(event: ReactPointerEvent) {
      if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) finish(event.pointerId)
    }
  }
  if (!cached && loaded?.asset === displayedAsset && loaded.error) return <span role="alert" className="sketch-error">{loaded.error}</span>
  const style = model ? { width: model.width, aspectRatio: `${model.width} / ${model.height}` } : undefined
  if (!active) return <button className="sketch-preview" type="button" style={style} aria-label="Edit sketch" onClick={open}>
    {model && <img alt="Sketch" src={'data:image/svg+xml,' + encodeURIComponent(sketchSvg(model, colors, false))} />}
  </button>
  return <span role="group" aria-label="Sketch editor" ref={frame} tabIndex={-1} className="sketch-canvas" style={style}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); exit() }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); step(event.shiftKey ? 'redo' : 'undo') }
        if (event.key.toLowerCase() === 's') { event.preventDefault(); save() }
      }
    }}>
    {model && <svg ref={surface} className="sketch-drawing" aria-label="Drawing surface" viewBox={`0 0 ${model.width} ${model.height}`}
      onPointerDown={e => begin(e, false)} {...pointer}>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {model.marks.map((mark, index) => <Mark key={index} mark={mark} index={index} />)}
        {eraserTrace && <g className="sketch-eraser-trace" opacity={0.4} pointerEvents="none"><Mark mark={eraserTrace} /></g>}
      </g>
    </svg>}
    <span role="toolbar" aria-label="Sketch tools" className="sketch-tools">
      {tools.map(([value, label, icon]) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon name={icon} /></button>)}
      <select aria-label="Brush thickness" title="Brush thickness" value={width} onChange={event => setWidth(Number(event.target.value))}>
        {[1, 2, 3, 5, 8, 12, 16].map(n => <option key={n} value={n}>{n} px</option>)}
      </select>
      {(['undo', 'redo'] as const).map(dir => <button type="button" key={dir} disabled={!history[dir].length} aria-label={dir === 'undo' ? 'Undo sketch edit' : 'Redo sketch edit'}
        title={dir === 'undo' ? 'Undo' : 'Redo'} onClick={() => step(dir)}><Icon name={dir} /></button>)}
    </span>
    <button type="button" className="sketch-resize" aria-label="Resize sketch" title="Resize sketch" onPointerDown={e => begin(e, true)} {...pointer}
      onKeyDown={e => {
        const base = currentAsset(), current = base && assets.cached(base)
        if (!base || !current || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault()
        commit(base, { ...current, width: clamp(current.width + (e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : 0), MIN_SKETCH_SIZE, MAX_SKETCH_SIZE),
          height: clamp(current.height + (e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0), MIN_SKETCH_SIZE, MAX_SKETCH_SIZE) })
      }}><Icon name="resize" /></button>
  </span>
}
