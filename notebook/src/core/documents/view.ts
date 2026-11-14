// The PDF reader's arithmetic, shared by the app and the server's web app so
// both readers zoom and track pages the same way.

/** The next zoom step: finer below 50%, 25 points at a time above, at most 300%. */
export function stepZoom(value: number, direction: 'in' | 'out'): number {
  const percent = Number((value * 100).toPrecision(12))
  const next = direction === 'out'
    ? percent > 50 ? Math.max(50, percent - 25) : percent > 30 ? Math.max(30, percent - 10) : percent > 5 ? Math.max(5, percent - 5) : percent / 2
    : percent < 5 ? Math.min(5, percent * 2) : percent < 30 ? Math.min(30, percent + 5) : percent < 50 ? Math.min(50, percent + 10) : Math.min(300, percent + 25)
  return Math.max(Number.MIN_VALUE, next / 100)
}

/** A typed zoom percentage ("125", "125 %") as a factor, or null when it is not one. */
export function parseZoomPercent(input: string): number | null {
  const text = input.trim().replace(/%$/, '').trim(), percent = Number(text)
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(percent) && percent > 0 && percent <= 300 && percent / 100 > 0 ? percent / 100 : null
}

/** A typed page number (whole, 1 to `count`), or null when it is not one. */
export function parsePageNumber(input: string, count: number): number | null {
  const text = input.trim(), page = Number(text)
  return /^\d+$/.test(text) && Number.isSafeInteger(page) && page >= 1 && page <= count ? page : null
}

/** The page whose slot contains `top`, given each page's top offset and the end. */
export function pageAt(offsets: number[], top: number): number {
  let low = 0, high = offsets.length - 2
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (offsets[middle]! <= top) low = middle; else high = middle - 1 }
  return low + 1
}

/**
 * Where to scroll so the line being read stays put when page sizes change - a
 * zoom, a resize, a page measured late. The reading line is `gap` below the
 * scroll top; it keeps its proportion of its page's height, and the gaps
 * between pages, which do not scale, are left out of that proportion. Scaling
 * them put a reader resumed at the top of a page just above it, on the page before.
 */
export function anchoredScrollTop(previous: number[], next: number[], scrollTop: number, gap: number): number {
  const anchor = pageAt(previous, scrollTop + gap + 1) - 1
  if (next[anchor] === undefined || next[anchor + 1] === undefined || previous[anchor + 1] === undefined) return scrollTop
  const before = previous[anchor + 1]! - previous[anchor]! - gap, after = next[anchor + 1]! - next[anchor]! - gap
  const within = scrollTop + gap - previous[anchor]!
  return Math.max(0, next[anchor]! + (before > 0 ? within * after / before : within) - gap)
}
