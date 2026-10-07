import { describe, expect, it } from 'vitest'
import { atBottom, NEAR_BOTTOM_PX } from '../src/core/coach/scroll'

describe('atBottom', () => {
  it('is true at the exact bottom', () => {
    expect(atBottom({ scrollTop: 640, scrollHeight: 1000, clientHeight: 360 })).toBe(true)
  })

  it('is true within the slack, because the bottom is rarely exactly zero', () => {
    expect(atBottom({ scrollTop: 640 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 360 })).toBe(true)
  })

  it('is false once the reader has scrolled past the slack', () => {
    expect(atBottom({ scrollTop: 640 - NEAR_BOTTOM_PX - 1, scrollHeight: 1000, clientHeight: 360 })).toBe(false)
  })

  it('is false well up the transcript', () => {
    expect(atBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 360 })).toBe(false)
  })

  it('is true for a window that does not overflow yet', () => {
    // A session that has only said one thing: nothing to scroll, so it is at the
    // bottom and the jump-to-latest button must not appear.
    expect(atBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 120 })).toBe(true)
  })

  it('tolerates the sub-pixel remainder a fractional line height leaves', () => {
    expect(atBottom({ scrollTop: 639.5, scrollHeight: 1000.25, clientHeight: 360 })).toBe(true)
  })

  it('takes a tighter slack when asked', () => {
    const near = { scrollTop: 630, scrollHeight: 1000, clientHeight: 360 }
    expect(atBottom(near)).toBe(true)
    expect(atBottom(near, 2)).toBe(false)
  })
})
