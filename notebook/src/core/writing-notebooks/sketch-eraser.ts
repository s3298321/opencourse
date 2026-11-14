import { arrowHead, sketchCircle, type Point, type Sketch, type SketchMark } from './sketch'

function distanceToSegment([x, y]: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared)) : 0
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
}
function side(a: Point, b: Point, p: Point): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}
// Both strokes have round caps and joins. Their centerlines can be up to the sum of their radii apart.
function segmentsTouch(a: Point, b: Point, c: Point, d: Point, reach: number): boolean {
  for (const axis of [0, 1]) {
    if (Math.min(a[axis], b[axis]) > Math.max(c[axis], d[axis]) + reach ||
        Math.min(c[axis], d[axis]) > Math.max(a[axis], b[axis]) + reach) return false
  }
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true
  return distanceToSegment(a, c, d) <= reach || distanceToSegment(b, c, d) <= reach ||
    distanceToSegment(c, a, b) <= reach || distanceToSegment(d, a, b) <= reach
}
interface TraceChunk { points: Point[]; left: number; right: number; top: number; bottom: number }

// Index short runs of the gesture once so distant marks can skip entire portions of a long drag.
function groupTrace(trace: Point[]): TraceChunk[] {
  const chunks: TraceChunk[] = []
  for (let i = 0; i < trace.length; i += 32) {
    const points = trace.slice(Math.max(0, i - 1), i + 32)
    const xs = points.map(p => p[0]), ys = points.map(p => p[1])
    chunks.push({ points, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) })
  }
  return chunks
}
function nearTrace(chunks: TraceChunk[], left: number, top: number, right: number, bottom: number,
  touches: (start: Point, end: Point) => boolean): boolean {
  return chunks.some(chunk => {
    if (chunk.right < left || chunk.left > right || chunk.bottom < top || chunk.top > bottom) return false
    for (let i = chunk.points.length === 1 ? 0 : 1; i < chunk.points.length; i++) {
      if (touches(chunk.points[i - 1] ?? chunk.points[i], chunk.points[i])) return true
    }
    return false
  })
}
function touchesTrace(mark: SketchMark, chunks: TraceChunk[], width: number): boolean {
  const reach = (width + mark.width) / 2
  let outline = mark.points
  const [a, b] = outline
  if (mark.kind === 'circle') {
    const { cx, cy, r } = sketchCircle(a, b), center: Point = [cx, cy], outer = r + reach
    // A segment touches the ring if its radial distances overlap the ring's band.
    return r > 0 && nearTrace(chunks, cx - outer, cy - outer, cx + outer, cy + outer, (start, end) =>
      distanceToSegment(center, start, end) <= outer &&
      Math.max(Math.hypot(start[0] - cx, start[1] - cy), Math.hypot(end[0] - cx, end[1] - cy)) >= r - reach)
  }
  if (mark.kind === 'rectangle') {
    if (a[0] === b[0] || a[1] === b[1]) return false
    outline = [a, [b[0], a[1]], b, [a[0], b[1]], a]
  } else if (mark.kind === 'arrow') {
    const [left, right] = arrowHead(a, b, mark.width)
    outline = [a, b, left, b, right]
  }
  return outline.some((end, i) => {
    const start = outline[i - 1] ?? end
    return nearTrace(chunks, Math.min(start[0], end[0]) - reach, Math.min(start[1], end[1]) - reach,
      Math.max(start[0], end[0]) + reach, Math.max(start[1], end[1]) + reach,
      (p, q) => segmentsTouch(start, end, p, q, reach))
  })
}

export function eraseSketchMarks(original: Sketch, trace: Point[], width: number): Sketch {
  const chunks = groupTrace(trace)
  const marks = original.marks.filter(mark => !touchesTrace(mark, chunks, width))
  return marks.length === original.marks.length ? original : { ...original, marks }
}
