/**
 * Web citations: from what OpenAI attached to an answer to what the side chat
 * shows - a numbered marker where the answer leans on a page, and the pages
 * themselves listed under it.
 *
 * Stored raw, rendered here. The database keeps each `url_citation` annotation
 * as it arrived (url, title, and the span of the answer it covers), and the
 * text keeps the model's own inline links, because that text goes back to the
 * model as history and it should read what it actually wrote. Numbering, the
 * markers and the list are this file's decision, made at render time, so a
 * better rendering never needs a migration.
 *
 * The span is located defensively, because two things about it are not
 * written down anywhere: the unit of its offsets (UTF-16, which is what a JS
 * string counts, or code points, which is what a Python one does - they part
 * ways at the first emoji) and what it covers (the inline `([host](url))` link
 * the model writes, or the sentence that link supports). So every offset is
 * checked against the text before it is trusted, the link is found by its URL
 * when the offsets do not hold, and a citation that cannot be placed at all is
 * still listed - a source is never lost to a marker that could not be drawn.
 */
import type { ChatCitation } from '../types'

/** Generous for one answer; a corrupt row stays small. */
export const MAX_CITATIONS = 50
const MAX_TITLE_CHARS = 300
const MAX_URL_CHARS = 2048

/**
 * Marks a citation link in the markdown, for core/markdown.ts to turn into a
 * superscript. A private-use character: it renders as nothing on its own, no
 * course or model has a reason to write it, and markdown-it passes it through
 * untouched.
 */
export const CITE_MARK = ''
/** Brackets a source number while the text is being rewritten; never rendered. */
const SLOT_OPEN = ''
const SLOT_CLOSE = ''

/** One page, numbered, as the list under an answer shows it. */
export interface CitedSource {
  n: number
  url: string
  title: string
  host: string
}

export interface CitedAnswer {
  /** The answer's markdown with its inline citation links replaced by numbered markers. */
  markdown: string
  sources: CitedSource[]
}

function isWebUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * The citations column, read the way every file here is read: whatever can
 * still be made sense of. Only http(s) pages survive - a `javascript:` URL in a
 * row would be stripped by the sanitizer anyway, but it should not reach the
 * favicon fetcher or a link either. Offsets that are not offsets become -1,
 * which `citeAnswer` reads as "list it, mark nothing".
 */
export function normalizeCitations(raw: unknown): ChatCitation[] {
  if (!Array.isArray(raw)) return []
  const kept: ChatCitation[] = []
  for (const entry of raw) {
    if (kept.length >= MAX_CITATIONS) break
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const url = record['url']
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !isWebUrl(url)) continue
    const title = typeof record['title'] === 'string' ? record['title'].trim().slice(0, MAX_TITLE_CHARS) : ''
    const start = record['start']
    const end = record['end']
    const valid =
      Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) >= (start as number)
    kept.push({ url, title, start: valid ? (start as number) : -1, end: valid ? (end as number) : -1 })
  }
  return kept
}

/** A page's site, as a person would name it: no scheme, no `www.`. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/**
 * OpenAI tags every cited URL with `utm_source=openai`; the same page cited
 * twice is one source, whether or not one of the two carries the tag.
 */
function withoutTracking(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('utm_source') === 'openai') parsed.searchParams.delete('utm_source')
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

/** The spellings a URL may have in the answer's text. */
function spellings(url: string): string[] {
  const bare = withoutTracking(url)
  return bare === url ? [url] : [url, bare]
}

/**
 * A page title, short enough for one line of a narrow column.
 *
 * Titles end in the site's own name more often than not - "asyncio - Python
 * 3.13 documentation", "How X works | MDN" - and the host is already shown
 * beside it, so one trailing segment goes, as long as what is left still
 * says something. Then a word-boundary cut with an ellipsis; CSS clips
 * whatever still does not fit, but a cut at a word reads better than one
 * mid-letter.
 */
export function shortTitle(title: string, url: string, max = 60): string {
  let text = title.replace(/\s+/g, ' ').trim()
  if (!text || /^https?:\/\//i.test(text)) {
    const host = hostOf(url)
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).at(-1)
      return last ? `${host} › ${decodeURIComponent(last)}`.slice(0, max) : host
    } catch {
      return host
    }
  }
  const separators = [...text.matchAll(/\s[|\-–—·•:]\s/g)]
  const last = separators.at(-1)
  if (last?.index !== undefined && last.index >= 12) text = text.slice(0, last.index).trim()
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  if (space > max * 0.6) cut = cut.slice(0, space)
  return `${cut.replace(/[\s,;:.\-–—|·]+$/, '')}…`
}

/** UTF-16 index of the code point at `points`, or -1 past the end. */
function codePointIndex(text: string, points: number): number {
  let index = 0
  for (let seen = 0; seen < points; seen++) {
    if (index >= text.length) return -1
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1
  }
  return index <= text.length ? index : -1
}

interface Span {
  from: number
  to: number
}

/**
 * What is already spoken for: links being replaced, and points where a marker
 * is going in. A replacement may not swallow either; several markers may go
 * in at one point, because two pages can support one sentence.
 */
interface Taken {
  links: Span[]
  points: number[]
}

const overlaps = (span: Span, taken: Taken): boolean =>
  taken.links.some((link) => span.from < link.to && link.from < span.to) ||
  taken.points.some((point) => span.from < point && point < span.to)

/** An insertion point, moved past any link being replaced around it. */
function pointOutside(at: number, taken: Taken): number {
  const inside = taken.links.find((link) => at > link.from && at < link.to)
  return inside ? inside.to : at
}

/**
 * The markdown link whose destination starts at `at` (just past `](`), widened
 * to the parentheses the model wraps its inline citations in. Null if what is
 * there is not a whole link to this URL - a longer URL it is a prefix of, say.
 */
function linkSpan(text: string, open: number, destinationEnd: number): Span | null {
  const label = text.lastIndexOf('[', open)
  if (label === -1 || text.slice(label, open).includes('\n')) return null
  const tail = /^>?(?:\s+"(?:[^"\\]|\\.)*")?\)/.exec(text.slice(destinationEnd))
  if (!tail) return null
  let from = label
  let to = destinationEnd + tail[0].length
  if (text[from - 1] === '(' && text[to] === ')') {
    from--
    to++
  }
  return { from, to }
}

/** The first untaken link to `url` at or after `from`. */
function findLink(text: string, url: string, from: number, taken: Taken): Span | null {
  for (const spelling of spellings(url)) {
    for (const opener of ['](', '](<']) {
      const needle = opener + spelling
      for (let at = text.indexOf(needle, from); at !== -1; at = text.indexOf(needle, at + 1)) {
        const span = linkSpan(text, at, at + needle.length)
        if (span && !overlaps(span, taken)) return span
      }
    }
  }
  return null
}

/** Pushed forward to the end of a word, so a marker never lands inside one. */
function wordEnd(text: string, at: number): number {
  const word = /[\p{L}\p{N}_]/u
  let index = at
  while (index > 0 && index < text.length && word.test(text[index - 1]!) && word.test(text[index]!)) index++
  return index
}

/**
 * Where a citation's marker goes: a span to replace (the model's own inline
 * link) or a point to insert at (`from === to`), or null if nowhere can be
 * trusted.
 */
function locate(text: string, citation: ChatCitation, taken: Taken): Span | null {
  const { url, start, end } = citation
  const candidates: Span[] = []
  if (start >= 0) {
    candidates.push({ from: start, to: end })
    const from = codePointIndex(text, start)
    const to = codePointIndex(text, end)
    if (from !== -1 && to !== -1 && (from !== start || to !== end)) candidates.push({ from, to })
  }
  const inRange = candidates.filter((c) => c.to <= text.length)

  // An offset is trusted when the text it points at mentions the page.
  const verified = inRange.find((c) => spellings(url).some((s) => text.slice(c.from, c.to).includes(s)))
  if (verified) {
    const link = findLink(text, url, Math.max(0, verified.from - 1), taken)
    if (link && link.to <= verified.to + 1) return link
    const at = pointOutside(wordEnd(text, verified.to), taken)
    return { from: at, to: at }
  }

  // Offsets that do not hold: the link is found by what it points to.
  const link = findLink(text, url, 0, taken)
  if (link) return link

  // No link in the text at all, so the span was the claim rather than the
  // link. Where the two units disagree the code-point reading wins: the
  // offsets come from a server that counts characters, not UTF-16 units.
  const point = inRange.at(-1)
  if (!point) return null
  const at = pointOutside(wordEnd(text, point.to), taken)
  return { from: at, to: at }
}

/** CommonMark: a `<…>` destination may not hold angle brackets or a newline. */
function destination(url: string): string {
  return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/[\r\n]/g, '')}>`
}

function linkTitle(title: string): string {
  return `"${title.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, '\\$&')}"`
}

/**
 * The answer as the side chat shows it: each cited span becomes a numbered
 * marker - `[n]` linking to the page, recognisable to the renderer by
 * `CITE_MARK` - and every page is listed once, in the order the text first
 * cites it.
 */
export function citeAnswer(text: string, citations: readonly ChatCitation[] | undefined): CitedAnswer {
  if (!citations?.length) return { markdown: text, sources: [] }

  // The private-use characters mean something to the renderer, so any already
  // in the text are swapped for an invisible one of the same length - the
  // offsets still line up, and nothing in an answer can forge a marker.
  const source = text.replace(/[]/g, '​')

  // In text order, so occurrences of a page cited twice are claimed in turn.
  const ordered = [...citations].sort((a, b) => (a.start < 0 ? 1 : b.start < 0 ? -1 : a.start - b.start))
  const taken: Taken = { links: [], points: [] }
  const placed: { span: Span; key: string }[] = []
  const unplaced: string[] = []
  const pages = new Map<string, { url: string; title: string }>()
  for (const citation of ordered) {
    const key = withoutTracking(citation.url)
    const page = pages.get(key)
    if (!page) pages.set(key, { url: citation.url, title: citation.title })
    else if (!page.title && citation.title) page.title = citation.title
    const span = locate(source, citation, taken)
    if (span) {
      if (span.from === span.to) taken.points.push(span.from)
      else taken.links.push(span)
      placed.push({ span, key })
    } else {
      unplaced.push(key)
    }
  }

  // Numbers follow the text; a page that could not be placed comes after.
  const numbers = new Map<string, number>()
  for (const { key } of [...placed].sort((a, b) => a.span.from - b.span.from)) {
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
  }
  for (const key of unplaced) if (!numbers.has(key)) numbers.set(key, numbers.size + 1)

  // Back to front, so earlier offsets stay put; at one point, the higher
  // number goes in first and ends up second.
  const byPosition = [...placed].sort(
    (a, b) => b.span.from - a.span.from || b.span.to - a.span.to || numbers.get(b.key)! - numbers.get(a.key)!
  )
  let rewritten = source
  for (const { span, key } of byPosition) {
    rewritten = rewritten.slice(0, span.from) + `${SLOT_OPEN}${numbers.get(key)}${SLOT_CLOSE}` + rewritten.slice(span.to)
  }

  const slot = `${SLOT_OPEN}\\d+${SLOT_CLOSE}`
  rewritten = rewritten
    // "([a](u1), [b](u2))" leaves its parentheses and comma around two slots.
    .replace(new RegExp(`\\(\\s*((?:${slot}\\s*[,;]?\\s*)+)\\)`, 'g'), '$1')
    // A marker sits against the word it supports, not a space away from it.
    .replace(new RegExp(`[ \\t]+(?=${slot})`, 'g'), '')
    .replace(new RegExp(`(${slot})\\s*[,;]?\\s*(?=${slot})`, 'g'), '$1')
    // The same page twice in a row is one marker.
    .replace(new RegExp(`(${slot})(?:\\1)+`, 'g'), '$1')

  const byNumber = new Map([...numbers].map(([key, n]) => [n, key]))
  const markdown = rewritten.replace(new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, 'g'), (_, digits: string) => {
    const page = pages.get(byNumber.get(Number(digits)) ?? '')
    return page ? `${CITE_MARK}[${digits}](${destination(page.url)} ${linkTitle(page.title || hostOf(page.url))})` : ''
  })

  const sources = [...numbers].map(([key, n]) => {
    const page = pages.get(key)!
    return { n, url: page.url, title: page.title, host: hostOf(page.url) }
  })
  return { markdown, sources }
}
