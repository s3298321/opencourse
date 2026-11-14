/**
 * The visualization selection bridge.
 *
 * Highlighting text in a lesson offers to ask the side chat about it. A
 * visualization is a sandboxed frame with an opaque origin, so the lesson
 * cannot read what is selected inside it - the frame has to say. Courses do
 * not write that code: the opencourse:// handler appends a tag loading this script
 * to every visualization page it serves, and serves the script itself at
 * VIZ_BRIDGE_PATH on every course's host (protocol.ts).
 *
 * A file, not an inline script, because a visualization runs under two
 * policies: its own, and the renderer's, which the session stamps on every
 * response (index.ts) and whose script-src is 'self' alone. An inline bridge
 * was refused; a same-origin file is allowed by both.
 *
 * Both directions are plain postMessage, tagged so neither side mistakes the
 * other's traffic - or the visualization's own - for its own:
 *
 *   frame -> app  { source: 'opencourse-viz', type: 'selection', text, rect }
 *                 (empty text when the selection goes away)
 *   app -> frame  { source: 'opencourse-app', type: 'mark' | 'unmark' }
 *
 * `mark` keeps the attached passage highlighted inside the frame while the
 * learner types about it, the way Lesson.tsx marks lesson text: a custom
 * highlight, because the frame's own selection is not what the learner is
 * looking at once the chat's composer has focus.
 *
 * What a visualization can do with this is propose text for an offer the
 * learner still has to press - the same trust as a selection. parseVizMessage
 * holds it to that shape, and main caps the quote again when it is sent.
 */
import { MAX_QUOTE_CHARS } from './sidechat/thread'
import { BRAND } from './brand'

export const VIZ_SOURCE = `${BRAND.name}-viz`
export const APP_SOURCE = `${BRAND.name}-app`
/** Shared with Lesson.tsx's highlight of lesson text, and styled the same. */
export const QUOTE_HIGHLIGHT = 'ask-quote'
/** Where the handler serves the script, on any course's host. Reserved. */
export const VIZ_BRIDGE_PATH = '/__opencourse/viz-bridge.js'

export interface VizRect {
  left: number
  top: number
  width: number
  height: number
}

/** A selection reported by a frame. Empty text means it went away. */
export interface VizSelection {
  text: string
  rect: VizRect | null
}

export type AppToViz = { source: typeof APP_SOURCE; type: 'mark' | 'unmark' }

/**
 * Runs inside the visualization. ES5-flavoured and self-contained on purpose:
 * it shares a page with someone else's code and must neither depend on nor
 * leak into it.
 */
export const VIZ_BRIDGE_SCRIPT = `(function () {
  var VIZ = ${JSON.stringify(VIZ_SOURCE)}, APP = ${JSON.stringify(APP_SOURCE)}, MARK = ${JSON.stringify(QUOTE_HIGHLIGHT)};
  if (window.parent === window) return;
  var saved = null, reported = false;
  function post(text, rect) {
    reported = Boolean(text);
    window.parent.postMessage({ source: VIZ, type: 'selection', text: text, rect: rect }, '*');
  }
  function report() {
    var sel = window.getSelection();
    var text = sel ? String(sel).trim() : '';
    if (!sel || !text || sel.rangeCount === 0) { saved = null; if (reported) post('', null); return; }
    var range = sel.getRangeAt(0), box = range.getBoundingClientRect();
    if (!box.width && !box.height) { saved = null; if (reported) post('', null); return; }
    saved = range.cloneRange();
    post(text, { left: box.left, top: box.top, width: box.width, height: box.height });
  }
  document.addEventListener('mouseup', report, true);
  document.addEventListener('keyup', function (e) { if (e.shiftKey) report(); }, true);
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (reported && (!sel || sel.isCollapsed)) post('', null);
  });
  window.addEventListener('message', function (e) {
    var data = e.data;
    if (e.source !== window.parent || !data || data.source !== APP) return;
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (data.type === 'mark' && saved) CSS.highlights.set(MARK, new Highlight(saved));
    if (data.type === 'unmark') CSS.highlights.delete(MARK);
  });
})();`

/**
 * The app's --accent-ring hue, a little stronger: the page cannot read the
 * app's tokens, and a visualization's background is its own, not the app's.
 */
const STYLE = `::highlight(${QUOTE_HIGHLIGHT}) { background: rgba(160, 160, 168, 0.32); }`

/** What goes into the page. Inline style is allowed by both policies; inline script is not. */
export const VIZ_BRIDGE = `<style data-opencourse-bridge>${STYLE}</style><script data-opencourse-bridge src="${VIZ_BRIDGE_PATH}"></script>`

/**
 * Appends the bridge to a visualization page: before the last `</body>`, or at
 * the end when the page leaves it out (the parser puts it in the body anyway).
 */
export function injectVizBridge(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body')
  return at === -1 ? html + VIZ_BRIDGE : html.slice(0, at) + VIZ_BRIDGE + html.slice(at)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The only shape the app accepts from a frame. Anything else - another
 * source, a missing field, a rect that is not four finite numbers - is null,
 * which callers treat as "not for us".
 */
export function parseVizMessage(data: unknown): VizSelection | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message['source'] !== VIZ_SOURCE || message['type'] !== 'selection') return null
  if (typeof message['text'] !== 'string') return null
  const text = message['text'].trim().slice(0, MAX_QUOTE_CHARS)
  if (!text) return { text: '', rect: null }

  const rect = message['rect'] as Record<string, unknown> | null | undefined
  if (!rect || typeof rect !== 'object') return null
  const { left, top, width, height } = rect
  if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null
  return { text, rect: { left, top, width, height } }
}
