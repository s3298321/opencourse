import { describe, expect, it } from 'vitest'
import { anchoredScrollTop, pageAt, parsePageNumber, parseZoomPercent, stepZoom } from '../src/core/documents/view'

describe('PDF reader arithmetic, shared by the app and the web', () => {
  it('steps zoom finely below 50% and by 25 points above, up to 300%', () => {
    expect(stepZoom(1, 'in')).toBe(1.25)
    expect(stepZoom(1, 'out')).toBe(0.75)
    expect(stepZoom(0.5, 'out')).toBe(0.4)
    expect(stepZoom(3, 'in')).toBe(3)
  })
  it('reads a typed percentage, with or without the sign', () => {
    expect(parseZoomPercent('125')).toBe(1.25)
    expect(parseZoomPercent(' 80 % ')).toBe(0.8)
    expect(parseZoomPercent('0')).toBeNull()
    expect(parseZoomPercent('301')).toBeNull()
    expect(parseZoomPercent('1e2')).toBeNull()
  })
  it('reads a typed page number only when it is a whole page in range', () => {
    expect(parsePageNumber(' 4 ', 8)).toBe(4)
    expect(parsePageNumber('8', 8)).toBe(8)
    for (const text of ['', 'abc', '5x', '0', '9', '-2', '2.5', '1e1', '0x5']) expect(parsePageNumber(text, 8)).toBeNull()
  })
  it('finds the page whose slot holds an offset', () => {
    const offsets = [24, 824, 1624, 2424]
    expect(pageAt(offsets, 0)).toBe(1)
    expect(pageAt(offsets, 825)).toBe(2)
    expect(pageAt(offsets, 5000)).toBe(3)
  })
})

describe('keeping the reading line when pages change size', () => {
  it('keeps a reader at the top of a page on that page, whatever the zoom', () => {
    const before = [24, 824, 1624, 2424], after = [24, 1024, 2024, 3024] // pages 800 → 1000 tall, 24 gaps
    expect(anchoredScrollTop(before, after, 824 - 24, 24)).toBe(1024 - 24)
    expect(pageAt(after, anchoredScrollTop(before, after, 824 - 24, 24) + 24 + 1)).toBe(2)
  })
  it('keeps the same proportion of the page being read', () => {
    const before = [24, 824, 1624], after = [24, 1624, 3224] // 776 → 1576 tall
    // Halfway down page 2's content.
    const top = 824 + 388 - 24
    expect(anchoredScrollTop(before, after, top, 24)).toBe(1624 + 788 - 24)
  })
})
