import { expect, it } from 'vitest'
import { eraseSketchMarks } from '../src/core/writing-notebooks/sketch-eraser'
import type { Point, Sketch, SketchMark } from '../src/core/writing-notebooks/sketch'

function drawing(...marks: SketchMark[]): Sketch {
  return { version: 1, width: 450, height: 300, marks }
}
const brush = (points: Point[], width = 2): SketchMark => ({ kind: 'brush', points, width })

it('sweeps the whole segment and includes both stroke radii, dots and overlapping marks', () => {
  const crossing = brush([[50, 0], [50, 100]]), dot = brush([[80, 54]], 2), miss = brush([[80, 54.1]])
  const sketch = drawing(crossing, crossing, dot, miss)
  expect(eraseSketchMarks(sketch, [[10, 50], [100, 50]], 6).marks).toEqual([miss])
  expect(eraseSketchMarks(sketch, [[54, 50]], 6).marks).toEqual([dot, miss])
  expect(eraseSketchMarks(sketch, [[55, 50]], 6)).toBe(sketch)
})

it('hits the painted outlines of circles and rectangles and skips their unfilled interiors', () => {
  const rect: SketchMark = { kind: 'rectangle', width: 2, points: [[70, 70], [30, 30]] }
  const circle: SketchMark = { kind: 'circle', width: 2, points: [[80, 50], [20, 50]] }
  const sketch = drawing(rect, circle)
  expect(eraseSketchMarks(sketch, [[42, 45], [56, 54]], 4)).toBe(sketch)
  expect(eraseSketchMarks(sketch, [[42, 28], [56, 28]], 4).marks).toEqual([circle])
  expect(eraseSketchMarks(sketch, [[0, 17], [100, 17]], 4).marks).toEqual([rect])
  expect(eraseSketchMarks(sketch, [[0, 50], [100, 50]], 4).marks).toEqual([])
})

it('erases an arrow by its head even when the trace misses the shaft', () => {
  const arrow: SketchMark = { kind: 'arrow', width: 8, points: [[20, 50], [100, 50]] }
  const sketch = drawing(arrow, brush(arrow.points, arrow.width))
  expect(eraseSketchMarks(sketch, [[80, 61]], 1).marks).toEqual([sketch.marks[1]])
})

it('includes the swept segment between adjacent groups of pointer samples', () => {
  const trace: Point[] = Array.from({ length: 32 }, (_, i) => [i, 50])
  trace.push([100, 50])
  const sketch = drawing(brush([[60, 49], [60, 51]]))
  expect(eraseSketchMarks(sketch, trace, 2).marks).toHaveLength(0)
})
