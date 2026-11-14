import { diffText, type KeptRun, type TextRange } from './text-diff'

const highlightName = 'authoring-arriving'
const ignored = 'button, input, textarea, select, script, style, [data-ask="none"], [data-authoring-motion-overlay], .cm-gutters'
// An element that is mostly new arrives whole, so a new list's markers, a
// code span's background or a quote's rule come with their text instead of
// standing empty while the words are still on their way.
const wholeBlocks = 'p, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, pre, blockquote, table, figure, details'
const wholeInlines = 'code, kbd, mark, a'
// What a departing element paints besides its words: those go with the sweep
// too, rather than leaving the old words hanging without their bullets.
const decorated = 'li, pre, code, kbd, mark, blockquote, th, td'
const soft = 'cubic-bezier(0.25, 0.1, 0.25, 1)', glide = 'cubic-bezier(0.45, 0, 0.2, 1)'
// One sweep runs down the changed lines - unchanged stretches between them
// cost no time - at a reading pace, sped up so a long rewrite still lands in
// about a second. Each line fades over `fadeIn`, so neighbours overlap.
const sweepSpeed = 0.45, sweepBudget = 1000, lag = 140, flow = 80, fadeIn = 380, fadeOut = 260, shift = 440
interface Piece extends TextRange { text: string; rect: DOMRect; style: Partial<CSSStyleDeclaration>; range: Range }
interface Media { key: string; signature: string; element: HTMLElement; rect: DOMRect; still: HTMLElement }
interface Decor { boxes: { rect: DOMRect; style: Partial<CSSStyleDeclaration> }[]; marker?: { text: string; rect: DOMRect; style: Partial<CSSStyleDeclaration> } }
interface Part { area: HTMLElement; text: string; nodes: { node: Text; offset: number }[]; pieces: Piece[]; media: Media[]; decor: Map<HTMLElement, Decor> }
interface Row { rect: DOMRect; clone: HTMLElement }
export interface MotionSnapshot { parts: Map<string, Part>; rows: Map<string, Row> }

export function motionAllowed(): boolean {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && typeof HTMLElement.prototype.animate === 'function' && typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}
const visible = (rect: DOMRect, root: DOMRect): boolean => rect.width > 0 && rect.height > 0 && rect.bottom > root.top && rect.top < root.bottom && rect.right > root.left && rect.left < root.right

function* textNodes(area: HTMLElement): Generator<Text> {
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (parent && !parent.closest(ignored) && parent.closest('[data-authoring-preview-key]') === area) yield node as Text
  }
}
/** What the preview says, cheaply: enough to tell whether it changed. */
export function previewText(root: HTMLElement): string {
  return [...root.querySelectorAll<HTMLElement>('[data-authoring-preview-key]')].map(area => [...textNodes(area)].map(node => node.data).join('')).join('\u0000')
}

function captureParts(root: HTMLElement): Map<string, Part> {
  const parts = new Map<string, Part>(), viewport = root.getBoundingClientRect()
  for (const area of root.querySelectorAll<HTMLElement>('[data-authoring-preview-key]')) {
    const part: Part = { area, text: '', nodes: [], pieces: [], media: [], decor: new Map() }
    for (const node of textNodes(area)) {
      const parent = node.parentElement!, text = node.data, offset = part.text.length
      part.text += text; part.nodes.push({ node, offset })
      if (!visible(parent.getBoundingClientRect(), viewport)) continue
      const computed = getComputedStyle(parent)
      const style = { fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontWeight: computed.fontWeight, fontStyle: computed.fontStyle,
        letterSpacing: computed.letterSpacing, color: computed.color, textDecoration: computed.textDecoration, lineHeight: computed.lineHeight }
      for (const word of text.matchAll(/\S+/gu)) {
        if (part.pieces.length >= 650) break
        const range = document.createRange()
        range.setStart(node, word.index!); range.setEnd(node, word.index! + word[0].length)
        const rects = [...range.getClientRects()]
        // Wrapped, very long tokens retain their normal rendering.
        if (rects.length !== 1 || !visible(rects[0], viewport)) continue
        part.pieces.push({ start: offset + word.index!, end: offset + word.index! + word[0].length, text: word[0], rect: rects[0], style, range })
      }
    }
    for (const [index, element] of [...area.querySelectorAll<HTMLElement>('img, video, iframe, canvas')].entries()) {
      if (element.closest('[data-authoring-preview-key]') !== area) continue
      const still = element.tagName === 'IMG' ? element.cloneNode(false) as HTMLElement : document.createElement('div')
      if (element.tagName !== 'IMG') { still.className = 'authoring-motion-media-placeholder'; still.textContent = element.tagName === 'VIDEO' ? 'Video' : 'Visualization' }
      part.media.push({ key: `${element.tagName}/${index}`, signature: `${element.getAttribute('src')}/${element.getAttribute('poster')}`, element, rect: element.getBoundingClientRect(), still })
    }
    for (const element of area.querySelectorAll<HTMLElement>(decorated)) {
      const rect = element.getBoundingClientRect()
      if (element.closest('[data-authoring-preview-key]') !== area || element.closest(ignored) || !visible(rect, viewport)) continue
      const computed = getComputedStyle(element), decor: Decor = { boxes: [] }, sides = ['Top', 'Right', 'Bottom', 'Left'] as const
      if (computed.backgroundColor !== 'rgba(0, 0, 0, 0)' || sides.some(side => parseFloat(computed[`border${side}Width`]) > 0)) {
        const style: Partial<CSSStyleDeclaration> = { backgroundColor: computed.backgroundColor, borderRadius: computed.borderRadius }
        for (const side of sides) style[`border${side}`] = `${computed[`border${side}Width`]} ${computed[`border${side}Style`]} ${computed[`border${side}Color`]}`
        decor.boxes = (computed.display.startsWith('inline') ? [...element.getClientRects()] : [rect]).map(box => ({ rect: box, style }))
      }
      const list = element.parentElement, type = computed.listStyleType
      const symbol = element.tagName !== 'LI' || computed.listStylePosition !== 'outside' ? undefined
        : type === 'decimal' && list instanceof HTMLOListElement ? `${list.start + [...list.children].filter(child => child.tagName === 'LI').indexOf(element)}. `
        : ({ disc: '\u2022 ', circle: '\u25E6 ', square: '\u25AA ' } as Record<string, string>)[type]
      if (symbol) {
        // An outside marker ends where the item's box starts, on its first line.
        const marker = getComputedStyle(element, '::marker'), line = computed.lineHeight === 'normal' ? parseFloat(computed.fontSize) * 1.2 : parseFloat(computed.lineHeight)
        decor.marker = { text: symbol, rect: new DOMRect(rect.left - 80, rect.top + parseFloat(computed.borderTopWidth) + parseFloat(computed.paddingTop), 80, line),
          style: { fontFamily: marker.fontFamily, fontSize: marker.fontSize, fontWeight: marker.fontWeight, fontVariantNumeric: marker.fontVariantNumeric, color: marker.color, textAlign: 'right' } }
      }
      if (decor.boxes.length || decor.marker) part.decor.set(element, decor)
    }
    parts.set(area.dataset.authoringPreviewKey!, part)
  }
  return parts
}
export function captureMotion(preview: HTMLElement, outline: HTMLElement): MotionSnapshot {
  return { parts: captureParts(preview), rows: new Map([...outline.querySelectorAll<HTMLElement>('[data-authoring-outline-id]')].map(row => [row.dataset.authoringOutlineId!, { rect: row.getBoundingClientRect(), clone: row.cloneNode(true) as HTMLElement }])) }
}
const changed = (piece: Piece, ranges: TextRange[]): boolean => ranges.some(range => range.start < piece.end && range.end > piece.start)
const within = (element: HTMLElement, others: Iterable<HTMLElement>): boolean => { for (const other of others) if (other !== element && other.contains(element)) return true; return false }

/** Each element's span of its part's text, and whether most of a span's
 * visible characters fall inside `ranges`. Mostly, not all: a sentence with
 * three of its words kept is still a rewritten sentence. */
function measure(part: Part, ranges: TextRange[], include: (element: HTMLElement) => boolean): { spans: Map<HTMLElement, TextRange>; mostly: (span: TextRange) => boolean } {
  const { text } = part
  const ink = new Uint32Array(text.length + 1), hit = new Uint32Array(text.length + 1), inside = new Uint8Array(text.length)
  for (const range of ranges) inside.fill(1, range.start, range.end)
  for (let i = 0; i < text.length; i++) { const solid = /\s/.test(text[i]) ? 0 : 1; ink[i + 1] = ink[i] + solid; hit[i + 1] = hit[i] + (solid & inside[i]) }
  const spans = new Map<HTMLElement, TextRange>()
  for (const { node, offset } of part.nodes) {
    for (let element = node.parentElement; element && element !== part.area; element = element.parentElement) {
      if (!include(element)) continue
      const span = spans.get(element), end = offset + node.data.length
      if (span) span.end = end; else spans.set(element, { start: offset, end })
    }
  }
  return { spans, mostly: ({ start, end }) => ink[end] > ink[start] && hit[end] - hit[start] >= (ink[end] - ink[start]) * 0.6 }
}

interface Arrivals { words: Piece[]; whole: HTMLElement[]; media: Media[]; moves: { element: HTMLElement; from: DOMRect; to: DOMRect }[]; slides: { piece: Piece; from: DOMRect }[]; standing: Piece[]; retired: Piece[] }
/** Sort a part's new rendering into what arrives whole, what arrives word by
 * word, what is unchanged but sits somewhere else now, and what stands still. */
function arrivals(part: Part, before: Part | undefined, added: TextRange[], kept: KeptRun[]): Arrivals {
  const { area, text } = part
  const blockish = (element: HTMLElement): boolean => element.parentElement === area || element.matches(wholeBlocks)
  const { spans, mostly } = measure(part, added, element => blockish(element) || element.matches(wholeInlines))
  const runOf = (start: number, end: number): KeptRun | undefined => kept.find(run => run.after <= start && end <= run.after + run.length)
  const oldPieces = new Map(before?.pieces.map(piece => [piece.start, piece]))
  const oldCopy = (piece: Piece): Piece | undefined => { const run = runOf(piece.start, piece.end); return run && oldPieces.get(run.before + piece.start - run.after) }
  // Unchanged blocks: all of their text inside one kept run.
  const steady = before ? [...spans].filter(([element, span]) => {
    let { start, end } = span
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    return blockish(element) && end > start && !!runOf(start, end)
  }).map(([element]) => element) : []
  // A block holding an unchanged paragraph is never revealed whole: that paragraph moves instead.
  const candidates = before ? [...spans].filter(([element, span]) => mostly(span) && !steady.some(inner => element.contains(inner))).map(([element]) => element)
    : [...area.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
  const whole = candidates.filter(element => !within(element, candidates))
  const result: Arrivals = { words: [], whole, media: [], moves: [], slides: [], standing: [], retired: [] }
  for (const element of steady) {
    if (within(element, steady)) continue
    // Located before and after by its first visible word.
    const span = spans.get(element)!, piece = part.pieces.find(entry => entry.start >= span.start && entry.end <= span.end), old = piece && oldCopy(piece)
    if (!piece || !old || (Math.abs(old.rect.top - piece.rect.top) < 1 && Math.abs(old.rect.left - piece.rect.left) < 1)) continue
    const to = element.getBoundingClientRect()
    result.moves.push({ element, to, from: new DOMRect(to.left + old.rect.left - piece.rect.left, to.top + old.rect.top - piece.rect.top, to.width, to.height) })
  }
  const settled = [...whole, ...result.moves.map(move => move.element)], inside = (node: Node, elements: HTMLElement[]): boolean => elements.some(element => element.contains(node))
  for (const piece of part.pieces) {
    if (inside(piece.range.startContainer, settled)) continue
    if (changed(piece, added)) { result.words.push(piece); continue }
    // A kept word in an edited paragraph: slides along its line, or, pushed
    // onto another line, leaves and arrives with the sweep like its neighbours.
    const old = oldCopy(piece)
    if (old && Math.abs(old.rect.top - piece.rect.top) >= 1) result.words.push(piece)
    else if (old && Math.abs(old.rect.left - piece.rect.left) >= 1) result.slides.push({ piece, from: old.rect })
    else result.standing.push(piece)
  }
  // Text kept inside something that arrives - a block revealed whole, or the
  // "tree" of "tree." becoming "tree," - has an old copy on screen that
  // nothing else removes: it leaves with the sweep instead of vanishing at once.
  if (before) for (const span of [...whole.map(element => spans.get(element)!), ...result.words]) {
    for (const run of kept) {
      const start = Math.max(span.start, run.after) - run.after + run.before, end = Math.min(span.end, run.after + run.length) - run.after + run.before
      if (start < end) result.retired.push(...before.pieces.filter(piece => piece.start < end && piece.end > start))
    }
  }
  for (const item of part.media) {
    if (inside(item.element, settled)) continue
    const old = before?.media.find(entry => entry.key === item.key)
    if (!old || old.signature !== item.signature) result.media.push(item)
    else if (Math.abs(old.rect.top - item.rect.top) >= 1 || Math.abs(old.rect.left - item.rect.left) >= 1) result.moves.push({ element: item.element, from: old.rect, to: item.rect })
  }
  return result
}

/** Overlays, CSS Highlights and Web Animations leave React's DOM, accessible
 * text, selection, code editors and embedded visualizations intact. Never
 * clone live frames. */
export function playMotion(snapshot: MotionSnapshot, preview: HTMLElement, outline: HTMLElement, changedRows: Set<string>, sameSelection: boolean): () => void {
  const animations: Animation[] = [], overlays: HTMLElement[] = []
  const hidden = new Highlight()
  CSS.highlights.set(highlightName, hidden)
  let disposed = false, lifetime = 0
  const overlay = (root: HTMLElement): HTMLElement => {
    const layer = document.createElement('div')
    layer.className = 'authoring-motion-overlay'; layer.dataset.authoringMotionOverlay = ''; layer.dataset.ask = 'none'
    layer.setAttribute('aria-hidden', 'true'); layer.inert = true
    root.append(layer); overlays.push(layer)
    return layer
  }
  const ink = overlay(preview), rows = overlay(outline)
  const animate = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, finish?: () => void): void => {
    const animation = element.animate(frames, { easing: soft, fill: 'both', ...options })
    animations.push(animation); lifetime = Math.max(lifetime, Number(options.delay ?? 0) + Number(options.duration ?? 0))
    void animation.finished.then(() => { if (!disposed) { animation.cancel(); finish?.() } }).catch(() => {})
  }
  const position = (element: HTMLElement, rect: DOMRect, root: HTMLElement): void => {
    const bounds = root.getBoundingClientRect()
    Object.assign(element.style, { left: `${rect.left - bounds.left + root.scrollLeft - root.clientLeft}px`, top: `${rect.top - bounds.top + root.scrollTop - root.clientTop}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  const ghost = (piece: Piece, kind: 'arriving' | 'departing' | 'sliding'): HTMLElement => {
    const span = document.createElement('span')
    span.className = `authoring-motion-word ${kind}`
    span.textContent = piece.text; Object.assign(span.style, piece.style)
    position(span, piece.rect, preview); span.style.lineHeight = `${piece.rect.height}px`; ink.append(span)
    return span
  }

  const viewport = preview.getBoundingClientRect(), nextParts = captureParts(preview)
  const departing = new Set<Piece>(), gone: Media[] = [], decor: Decor[] = []
  const arriving: Arrivals = { words: [], whole: [], media: [], moves: [], slides: [], standing: [], retired: [] }
  for (const key of new Set([...snapshot.parts.keys(), ...nextParts.keys()])) {
    const before = snapshot.parts.get(key), after = nextParts.get(key)
    const difference = diffText(before?.text ?? '', after?.text ?? '')
    if (before) {
      for (const piece of before.pieces) if (changed(piece, difference.removed)) departing.add(piece)
      gone.push(...before.media.filter(media => visible(media.rect, viewport) && !after?.media.some(item => item.key === media.key && item.signature === media.signature)))
      const { spans, mostly } = measure(before, difference.removed, element => before.decor.has(element))
      for (const [element, painted] of before.decor) if (spans.has(element) && mostly(spans.get(element)!)) decor.push(painted)
    }
    if (after && sameSelection) {
      const found = arrivals(after, before, difference.added, difference.kept)
      for (const field of ['words', 'whole', 'media', 'moves', 'slides', 'standing'] as const) (arriving[field] as unknown[]).push(...found[field])
      for (const piece of found.retired) departing.add(piece)
    }
  }

  // The sweep's track: every line where something leaves or arrives, in screen
  // order, old and new layouts alike, so at any height the old words go just
  // before the new ones come and nothing stands blank waiting its turn.
  const clip = (rect: DOMRect): [number, number] => [Math.max(rect.top, viewport.top), Math.min(rect.bottom, viewport.bottom)]
  const wholeRects = new Map(arriving.whole.map(element => [element, element.getBoundingClientRect()] as const))
  const lines = [...departing, ...arriving.words, ...gone, ...arriving.media, ...decor.flatMap(painted => painted.boxes)].map(item => clip(item.rect))
    .concat([...wholeRects.values()].filter(rect => visible(rect, viewport)).map(clip))
    .filter(([top, bottom]) => bottom > top).sort((a, b) => a[0] - b[0])
  const track: { top: number; bottom: number; at: number }[] = []
  let length = 0
  for (const [top, bottom] of lines) {
    const last = track.at(-1)
    if (last && top <= last.bottom) { if (bottom > last.bottom) { length += bottom - last.bottom; last.bottom = bottom } }
    else { track.push({ top, bottom, at: length }); length += bottom - top }
  }
  const speed = Math.max(sweepSpeed, length / sweepBudget)
  const sweep = (y: number): number => {
    let travelled = 0
    for (const span of track) { if (y < span.top) break; travelled = span.at + Math.min(y, span.bottom) - span.top }
    return travelled / speed
  }
  const across = (rect: DOMRect): number => Math.min(1, Math.max(0, (rect.left - viewport.left) / viewport.width)) * flow

  const leave = (element: HTMLElement, rect: DOMRect, delay: number): void => animate(element,
    [{ opacity: 1, filter: 'blur(0px)', transform: 'none' }, { opacity: 0, filter: 'blur(2px)', transform: 'translateY(-0.15em)' }], { delay: sweep(rect.top) + delay, duration: fadeOut }, () => element.remove())
  for (const painted of decor) {
    for (const { rect, style } of painted.boxes) {
      const box = document.createElement('div'); box.className = 'authoring-motion-box'; Object.assign(box.style, style)
      position(box, rect, preview); ink.prepend(box); leave(box, rect, 0)
    }
    if (painted.marker) {
      const { text, rect, style } = painted.marker, span = document.createElement('span')
      span.className = 'authoring-motion-word departing'; span.textContent = text; Object.assign(span.style, style)
      position(span, rect, preview); span.style.lineHeight = `${rect.height}px`; ink.append(span); leave(span, rect, 0)
    }
  }
  for (const piece of departing) leave(ghost(piece, 'departing'), piece.rect, across(piece.rect))
  for (const media of gone) {
    const still = media.still; still.classList.add('authoring-motion-media')
    position(still, media.rect, preview); ink.append(still); leave(still, media.rect, 0)
  }
  for (const piece of arriving.words) {
    const span = ghost(piece, 'arriving')
    hidden.add(piece.range)
    animate(span, [{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(0.2em)' }, { opacity: 1, filter: 'blur(0px)', transform: 'none' }],
      { delay: sweep(piece.rect.top) + lag + across(piece.rect), duration: fadeIn }, () => { hidden.delete(piece.range); span.remove() })
  }
  for (const { piece, from } of arriving.slides) {
    const span = ghost(piece, 'sliding')
    hidden.add(piece.range)
    animate(span, [{ transform: `translateX(${from.left - piece.rect.left}px)` }, { transform: 'none' }],
      { delay: sweep(piece.rect.top), duration: shift - 80, easing: glide }, () => { hidden.delete(piece.range); span.remove() })
  }
  for (const [element, rect] of wholeRects) {
    if (!visible(rect, viewport)) continue
    const [top, bottom] = clip(rect), delay = sweep(top) + lag
    if (getComputedStyle(element).display.startsWith('inline')) {
      animate(element, [{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0px)' }], { delay: delay + across(rect), duration: fadeIn })
      continue
    }
    // A soft edge `feather` px deep slides down the element at the sweep's
    // speed, so each of its lines takes as long to appear as a word does. The
    // mask is wider than the box and unclipped, or list markers hanging in the
    // margin would only appear when it lifts.
    const feather = Math.max(24, speed * fadeIn), margin = 64, height = rect.height + feather
    const layer = { maskImage: `linear-gradient(#000 calc(100% - ${feather}px), transparent)`, maskSize: `calc(100% + ${2 * margin}px) ${height}px`, maskRepeat: 'no-repeat', maskClip: 'no-clip' }
    const from = top - rect.top - height, to = bottom - rect.bottom
    animate(element, [{ ...layer, maskPosition: `${-margin}px ${from}px` }, { ...layer, maskPosition: `${-margin}px ${to}px` }], { delay, duration: (to - from) / speed, easing: 'linear' })
  }
  for (const media of arriving.media) if (visible(media.rect, viewport)) {
    animate(media.element, [{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(6px)' }, { opacity: 1, filter: 'blur(0px)', transform: 'none' }], { delay: sweep(media.rect.top) + lag, duration: fadeIn + 80 })
  }
  // Pushed down: leave ahead of the new lines filling the space, at once if a
  // kept word already stands where it was, and never after anything above it,
  // or the two close up. Pulled up: wait until the lines it closes over have
  // mostly gone.
  let pushed = Infinity
  for (const { element, from, to } of arriving.moves.sort((a, b) => a.from.top - b.from.top)) {
    const crowded = arriving.standing.some(({ rect }) => rect.bottom > from.top && rect.top < from.bottom && rect.right > from.left && rect.left < from.right)
    const delay = to.top < from.top ? sweep(from.top) + 120 : (pushed = Math.min(pushed, crowded ? 0 : Math.max(0, sweep(from.top) - 200)))
    animate(element, [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { delay, duration: shift, easing: glide })
  }

  const outlineBox = outline.getBoundingClientRect()
  const currentRows = new Map([...outline.querySelectorAll<HTMLElement>('[data-authoring-outline-id]')].filter(row => !row.closest('[data-authoring-motion-overlay]')).map(row => [row.dataset.authoringOutlineId!, row]))
  const badge = (row: HTMLElement, text: string): void => {
    const label = document.createElement('span'); label.className = 'authoring-motion-badge'; label.textContent = text; label.setAttribute('aria-hidden', 'true')
    row.append(label)
    animate(label, [{ opacity: 0 }, { opacity: 1, offset: .14 }, { opacity: 1, offset: .7 }, { opacity: 0 }], { duration: 1350 }, () => label.remove())
  }
  let added = 0
  for (const [id, row] of currentRows) {
    const rect = row.getBoundingClientRect(), old = snapshot.rows.get(id)
    if (!visible(rect, outlineBox)) continue
    if (!old) {
      // A new row needs no label: it fades into the gap the rows below open for it.
      animate(row, [{ opacity: 0, filter: 'blur(2px)', transform: 'translateY(4px)' }, { opacity: 1, filter: 'blur(0px)', transform: 'none' }], { duration: 460, delay: 120 + Math.min(added++ * 45, 220) })
    } else {
      const dx = old.rect.left - rect.left, dy = old.rect.top - rect.top
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) animate(row, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 360, easing: glide })
      if (changedRows.has(id)) {
        const edge = document.createElement('span'); edge.className = 'authoring-motion-edge'; edge.setAttribute('aria-hidden', 'true'); (row.querySelector('.outline-row') ?? row).append(edge)
        animate(edge, [{ opacity: .65 }, { opacity: 0 }], { duration: 1100 }, () => edge.remove())
        badge(row, 'Updated')
      }
    }
  }
  for (const [id, old] of snapshot.rows) if (!currentRows.has(id) && visible(old.rect, outlineBox)) {
    const ghost = old.clone
    ghost.classList.add('authoring-motion-row'); ghost.removeAttribute('data-authoring-outline-id')
    ghost.querySelectorAll('[data-authoring-motion-overlay], .authoring-motion-badge').forEach(element => element.remove())
    position(ghost, old.rect, outline); rows.append(ghost); badge(ghost, 'Removed')
    animate(ghost, [{ opacity: .6, filter: 'blur(0)', transform: 'translateY(0)' }, { opacity: 0, filter: 'blur(3px)', transform: 'translateY(-5px)' }], { duration: 230 }, () => ghost.remove())
  }
  const clear = (): void => {
    disposed = true; animations.forEach(animation => animation.cancel()); overlays.forEach(layer => layer.remove())
    outline.querySelectorAll('.authoring-motion-badge, .authoring-motion-edge').forEach(label => label.remove())
    hidden.clear()
    if (CSS.highlights.get(highlightName) === hidden) CSS.highlights.delete(highlightName)
  }
  // A bounded lifetime also covers suspended/hidden windows and interrupted edits.
  const timer = window.setTimeout(clear, lifetime + 150)
  return () => { window.clearTimeout(timer); clear() }
}
