/**
 * A course's description and prerequisites are an author's markdown. Raw HTML
 * is off in markdown-it, which already refuses javascript: links; DOMPurify
 * runs after it anyway, and the page's CSP runs no inline script whatever gets
 * through. Links leave the site without a referrer or an opener.
 */
import { CITE_MARK } from '@core/sidechat/citations'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { loadCodeHighlighter, resolveCodeLanguage } from '@core/code-highlighter'
import '../styles/syntax.css'

// Initialize before the first render, including a direct visit to a lesson.
const highlighter = await loadCodeHighlighter()
const md = new MarkdownIt({
  html: false, linkify: true, typographer: false,
  highlight(code, language): string {
    const lang = resolveCodeLanguage(language || '')
    if (!lang) return ''
    try {
      const { tokens } = highlighter.codeToTokens(code, { lang, theme: 'github-dark' })
      // The web CSP forbids inline styles. Use external CSS classes for Shiki's
      // theme colors and font styles, then sanitize with the rest of the prose.
      const lines = tokens.map((line) => line.map((token) => {
        const classes: string[] = []
        if (token.color && /^#[0-9a-f]{6}$/i.test(token.color)) classes.push(`syntax-${token.color.slice(1).toLowerCase()}`)
        if ((token.fontStyle ?? 0) & 1) classes.push('syntax-italic')
        if ((token.fontStyle ?? 0) & 2) classes.push('syntax-bold')
        if ((token.fontStyle ?? 0) & 4) classes.push('syntax-underline')
        return `<span class="${classes.join(' ')}">${md.utils.escapeHtml(token.content)}</span>`
      }).join(''))
      return `<pre class="syntax-highlight"><code>${lines.join('\n')}</code></pre>`
    } catch {
      return '' // markdown-it escapes unknown or unsupported code as plain text.
    }
  }
})
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('rel', 'nofollow ugc noopener noreferrer')
  tokens[idx]!.attrSet('target', '_blank')
  return defaultLink(tokens, idx, options, env, self)
}

const clean = (html: string): string => DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input'] })

export const renderMarkdown = (text: string): string => clean(md.render(text).replace(new RegExp(`${CITE_MARK}(<a\\b[^>]*>\\d{1,3}</a>)`, 'g'), '<sup class="cite">$1</sup>').replaceAll(CITE_MARK, ''))
export const renderInline = (text: string): string => clean(md.renderInline(text))

/** Markdown down to its words, for a card's summary. */
export const plainText = (text: string): string => text.replace(/[#*_`>[\]()!]/g, '').replace(/\s+/g, ' ').trim()
