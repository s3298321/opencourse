export interface TextRange { start: number; end: number }
/** A stretch of text present in both versions, by offset in each. */
export interface KeptRun { before: number; after: number; length: number }
interface Token extends TextRange { value: string }
interface Run { x: number; y: number; n: number }
const tokenize = (text: string): Token[] => [...text.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)]
  .map(match => ({ value: match[0], start: match.index!, end: match.index! + match[0].length }))

/** Match unchanged words, including separate edits in the same paragraph.
 * Unique-word anchors bound the work for large lessons; small gaps use LCS. */
export function diffText(before: string, after: string): { removed: TextRange[]; added: TextRange[]; kept: KeptRun[] } {
  const a = tokenize(before), b = tokenize(after), keptA = new Set<number>(), keptB = new Set<number>(), pairs = new Map<number, number>()
  const keep = (x: number, y: number): void => { keptA.add(x); keptB.add(y); pairs.set(x, y) }
  const match = (a0: number, a1: number, b0: number, b1: number): void => {
    while (a0 < a1 && b0 < b1 && a[a0].value === b[b0].value) keep(a0++, b0++)
    while (a0 < a1 && b0 < b1 && a[a1 - 1].value === b[b1 - 1].value) keep(--a1, --b1)
    if (a0 === a1 || b0 === b1) return
    const n = a1 - a0, m = b1 - b0
    if (n * m <= 160000) {
      const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
      for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) {
        table[x][y] = a[a0 + x].value === b[b0 + y].value ? table[x + 1][y + 1] + 1 : Math.max(table[x + 1][y], table[x][y + 1])
      }
      let x = 0, y = 0
      while (x < n && y < m) {
        if (a[a0 + x].value === b[b0 + y].value) keep(a0 + x++, b0 + y++)
        else if (table[x + 1][y] >= table[x][y + 1]) x++
        else y++
      }
      return
    }
    const unique = (tokens: Token[], start: number, end: number): Map<string, number> => {
      const positions = new Map<string, number>()
      for (let i = start; i < end; i++) positions.set(tokens[i].value, positions.has(tokens[i].value) ? -1 : i)
      return positions
    }
    const left = unique(a, a0, a1), right = unique(b, b0, b1)
    const anchors = [...left].filter(([value, pos]) => pos >= 0 && (right.get(value) ?? -1) >= 0).map(([value, x]) => ({ x, y: right.get(value)! }))
    // Longest increasing subsequence keeps anchors in document order.
    const tails: number[] = [], parents = new Int32Array(anchors.length).fill(-1)
    anchors.forEach((anchor, i) => {
      let lo = 0, hi = tails.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (anchors[tails[mid]].y < anchor.y) lo = mid + 1; else hi = mid }
      if (lo) parents[i] = tails[lo - 1]
      tails[lo] = i
    })
    const sequence: typeof anchors = []
    for (let i = tails.at(-1) ?? -1; i >= 0; i = parents[i]) sequence.unshift(anchors[i])
    for (const anchor of sequence) { match(a0, anchor.x, b0, anchor.y); keep(anchor.x, anchor.y); a0 = anchor.x + 1; b0 = anchor.y + 1 }
    if (sequence.length) match(a0, a1, b0, b1)
  }
  match(0, a.length, 0, b.length)
  const runs = cleanup([...keptA].sort((x, y) => x - y).map(x => [x, pairs.get(x)!] as const), a, b)
  keptA.clear(); keptB.clear()
  for (const run of runs) for (let i = 0; i < run.n; i++) { keptA.add(run.x + i); keptB.add(run.y + i) }
  const ranges = (tokens: Token[], kept: Set<number>): TextRange[] => {
    const result: TextRange[] = []
    tokens.forEach((token, i) => {
      if (kept.has(i)) return
      const previous = result.at(-1)
      if (previous?.end === token.start) previous.end = token.end
      else result.push({ start: token.start, end: token.end })
    })
    return result
  }
  return { removed: ranges(a, keptA), added: ranges(b, keptB),
    kept: runs.map(run => ({ before: a[run.x].start, after: b[run.y].start, length: a[run.x + run.n - 1].end - a[run.x].start })) }
}

/** Semantic cleanup: an unchanged run no longer than the edits on both sides
 * of it is folded into them. A rewrite then reads as one rewrite rather than a
 * scatter of surviving "the", "a" and commas standing in an empty paragraph. */
function cleanup(pairs: (readonly [number, number])[], a: Token[], b: Token[]): Run[] {
  let runs: Run[] = []
  for (const [x, y] of pairs) {
    const last = runs.at(-1)
    if (last && last.x + last.n === x && last.y + last.n === y) last.n++
    else runs.push({ x, y, n: 1 })
  }
  const edge = (tokens: Token[], i: number): number => i < tokens.length ? tokens[i].start : tokens.at(-1)?.end ?? 0
  const end = (tokens: Token[], run: Run | undefined, side: 'x' | 'y'): number => run ? tokens[run[side] + run.n - 1].end : 0
  for (let changed = true; changed;) {
    changed = false
    const edits = runs.map((run, i) => Math.max(edge(a, run.x) - end(a, runs[i - 1], 'x'), edge(b, run.y) - end(b, runs[i - 1], 'y')))
    edits.push(Math.max(edge(a, a.length) - end(a, runs.at(-1), 'x'), edge(b, b.length) - end(b, runs.at(-1), 'y')))
    // Folding only ever grows the neighbouring edits, so every run that
    // qualifies now still qualifies after its neighbours fold too.
    const kept = runs.filter((run, i) => {
      const length = a[run.x + run.n - 1].end - a[run.x].start
      return !(length <= edits[i] && length <= edits[i + 1])
    })
    changed = kept.length !== runs.length; runs = kept
  }
  return runs
}
