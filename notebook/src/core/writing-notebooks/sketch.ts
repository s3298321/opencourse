import { colorCss, parseColor } from '../theme/color'

export interface SketchSettings { width: number; height: number; shortcut: string }
export const DEFAULT_SKETCH: SketchSettings = { width: 450, height: 300, shortcut: 'Mod-e' }
export const MIN_SKETCH_SIZE = 96
export const MAX_SKETCH_SIZE = 4096
export const MAX_SKETCH_BYTES = 8 * 1024 * 1024
const reserved = new Set('a c f h i l m n q r s u v w x y z 0 Shift-d Shift-i Shift-k Shift-u Shift-z Alt-i Alt-h'.split(' ').map(key => 'Mod-' + key))
export function validShortcut(key: unknown): key is string {
  return typeof key === 'string' && /^Mod-(?:Alt-)?(?:Shift-)?[a-z0-9]$/.test(key) && !reserved.has(key)
}
export function validSketchSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_SKETCH_SIZE && n <= MAX_SKETCH_SIZE
}
export function sketchSettings(raw?: Partial<SketchSettings> | null): SketchSettings {
  return { width: validSketchSize(raw?.width) ? raw.width : DEFAULT_SKETCH.width,
    height: validSketchSize(raw?.height) ? raw.height : DEFAULT_SKETCH.height,
    shortcut: validShortcut(raw?.shortcut) ? raw.shortcut : DEFAULT_SKETCH.shortcut }
}
export type Point = [number, number]
export type MarkKind = 'brush' | 'rectangle' | 'circle' | 'arrow'
export interface SketchMark { kind: MarkKind; width: number; points: Point[] }
export interface Sketch { version: 1; width: number; height: number; marks: SketchMark[] }
export interface SketchColors { background: string; brush: string }
export const darkSketchColors: SketchColors = { background: '#252525', brush: '#ffffff' }
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const sketchAssetPattern = 'assets/' + uuid + '\\.sketch\\.svg'
export const sketchAsset = new RegExp('^' + sketchAssetPattern + '$')
export const sketchLine = new RegExp('^!\\[[^\\]\\n]*\\]\\((' + sketchAssetPattern + ')\\)$')

/** Reconstruct only supported numeric geometry before generating any markup. */
export function validateSketch(value: unknown): Sketch {
  const invalid = () => { throw new Error('Invalid or oversized notebook sketch.') }
  const model = value as Partial<Sketch> | null
  if (!model || model.version !== 1 || !validSketchSize(model.width) || !validSketchSize(model.height) ||
      !Array.isArray(model.marks) || model.marks.length > 10000) return invalid()
  let count = 0
  const marks = model.marks.map(mark => {
    if (!mark || !['brush', 'rectangle', 'circle', 'arrow'].includes(mark.kind) || !Number.isInteger(mark.width) ||
        mark.width < 1 || mark.width > 32 || !Array.isArray(mark.points) || !mark.points.length ||
        (mark.kind !== 'brush' && mark.points.length !== 2)) return invalid()
    count += mark.points.length
    if (count > 100000) return invalid()
    const points = mark.points.map((p): Point => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(n => Number.isFinite(n) && n >= 0 && n <= MAX_SKETCH_SIZE)) return invalid()
      return [p[0], p[1]]
    })
    return { kind: mark.kind, width: mark.width, points }
  })
  return { version: 1, width: model.width, height: model.height, marks }
}

export function sketchCircle([x, y]: Point, [endX, endY]: Point) {
  return { cx: (x + endX) / 2, cy: (y + endY) / 2, r: Math.hypot(endX - x, endY - y) / 2 }
}
export function arrowHead([x, y]: Point, [endX, endY]: Point, width: number): [Point, Point] {
  const dx = endX - x, dy = endY - y, angle = Math.atan2(dy, dx)
  const length = Math.min(Math.hypot(dx, dy) * .55, 7 + width * 2)
  const tip = (offset: number): Point => [endX - length * Math.cos(angle + offset), endY - length * Math.sin(angle + offset)]
  return [tip(-.5), tip(.5)]
}
export function markGeometry(mark: SketchMark): { element: 'rect' | 'circle' | 'path'; attributes: Record<string, number | string> } {
  const [x, y] = mark.points[0], [endX, endY] = mark.points.at(-1)!
  const dx = endX - x, dy = endY - y
  if (mark.kind === 'rectangle') return { element: 'rect', attributes: { x: Math.min(x, endX), y: Math.min(y, endY), width: Math.abs(dx), height: Math.abs(dy) } }
  if (mark.kind === 'circle') return { element: 'circle', attributes: sketchCircle(mark.points[0], mark.points[1]) }
  if (mark.kind === 'arrow') {
    const [left, right] = arrowHead(mark.points[0], mark.points[1], mark.width)
    return { element: 'path', attributes: { d: `M${x},${y} L${endX},${endY} M${left} L${endX},${endY} ${right}` } }
  }
  const points = mark.points.length === 1 ? [mark.points[0], mark.points[0]] : mark.points
  return { element: 'path', attributes: { d: `M${points.join(' L')}` } }
}
function markedSvg(mark: SketchMark): string {
  const { element, attributes } = markGeometry(mark)
  const geometry = Object.entries(attributes).map(([name, value]) => `${name}="${value}"`).join(' ')
  return `<${element} ${geometry} stroke-width="${mark.width}"/>`
}
export function sketchSvg(model: Sketch, colors: SketchColors, metadata = true): string {
  const background = parseColor(colors?.background), brush = parseColor(colors?.brush)
  if (!background || !brush) throw new Error('Invalid sketch colors.')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}">` +
    (metadata ? `<metadata id="opencourse-sketch">${JSON.stringify(model)}</metadata>` : '') +
    `<rect width="100%" height="100%" fill="${colorCss(background)}"/><g fill="none" stroke="${colorCss(brush)}" stroke-linecap="round" stroke-linejoin="round">${model.marks.map(markedSvg).join('')}</g></svg>`
}
export function decodeSketch(svg: string): Sketch {
  const metadata = /<metadata id="opencourse-sketch">([^<]*)<\/metadata>/.exec(svg)
  if (!metadata) throw new Error('Missing sketch metadata.')
  return validateSketch(JSON.parse(metadata[1]))
}
