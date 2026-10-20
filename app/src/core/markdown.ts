/**
 * Markdown rendering. Ported from apps/courses/markdown.py: same markdown-it
 * CommonMark configuration, the same tag/attribute allowlist, Pygments swapped
 * for Shiki (dual light/dark themes via CSS variables) and bleach for DOMPurify.
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { loadCodeHighlighter, resolveCodeLanguage } from './code-highlighter'
import { CITE_MARK } from './sidechat/citations'
import { ASSET_SCHEMES } from './brand'

export const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table', 'thead', 'tbody', 'tr',
  'th', 'td', 'del', 'ins', 'sup', 'sub', 'span', 'div'
]

export const ALLOWED_ATTR = ['href', 'title', 'rel', 'src', 'alt', 'class', 'style', 'align', 'tabindex']

/** http(s)/mailto for prose links, opencourse: for course assets. */
export const ALLOWED_URI_REGEXP = new RegExp(`^(?:https?|mailto|${ASSET_SCHEMES.join('|')}):`, 'i')

export interface MarkdownRenderer {
  /** Block-level render: paragraphs, headings, code fences, tables. */
  render(source: string): string
  /** Inline-only render, for one-liners like a quiz question or option. */
  renderInline(source: string): string
}

/**
 * Shiki loads its grammars asynchronously, so the renderer is built once at
 * startup and used synchronously afterwards.
 */
export async function createRenderer(): Promise<MarkdownRenderer> {
  const highlighter = await loadCodeHighlighter()

  const md = new MarkdownIt('commonmark', {
    html: false,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      const resolved = resolveCodeLanguage(lang || '')
      if (!resolved) return '' // let markdown-it escape it into a plain <pre><code>
      try {
        return highlighter.codeToHtml(code, {
          lang: resolved,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false
        })
      } catch {
        return ''
      }
    }
  })
  md.enable('table')

  const clean = (dirty: string): string =>
    DOMPurify.sanitize(dirty, {
      // No USE_PROFILES here: it would *widen* ALLOWED_TAGS to the whole HTML
      // profile (forms, inputs, buttons). The list above is the whole contract.
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP
    })

  return {
    render: (source: string) => clean(markCitations(md.render(source ?? ''))),
    renderInline: (source: string) => clean(md.renderInline(source ?? ''))
  }
}

/**
 * A side chat answer's citation markers (core/sidechat/citations.ts) arrive as
 * an ordinary markdown link with `CITE_MARK` in front of it. This makes each
 * one a superscript, and drops a mark that did not end up in front of a link -
 * inside a code span, say. It runs before the sanitizer, which still has the
 * last word on the link: `sup` and `class` are already on the allowlist, and
 * `href` and `title` arrive here escaped by markdown-it.
 */
function markCitations(html: string): string {
  if (!html.includes(CITE_MARK)) return html
  return html
    .replace(
      new RegExp(`${CITE_MARK}<a href="([^"]*)"(?: title="([^"]*)")?>(\\d{1,3})</a>`, 'g'),
      (_, href: string, title: string | undefined, n: string) =>
        `<sup class="cite"><a href="${href}"${title ? ` title="${title}"` : ''}>${n}</a></sup>`
    )
    .replaceAll(CITE_MARK, '')
}

/** Plain-text escape for the small strings we render outside markdown. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}
