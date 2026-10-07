/**
 * A course's description and prerequisites are an author's markdown. Raw HTML
 * is off in markdown-it, which already refuses javascript: links; DOMPurify
 * runs after it anyway, and the page's CSP runs no inline script whatever gets
 * through. Links leave the site without a referrer or an opener.
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('rel', 'nofollow ugc noopener noreferrer')
  tokens[idx]!.attrSet('target', '_blank')
  return defaultLink(tokens, idx, options, env, self)
}

const clean = (html: string): string => DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input'] })

export const renderMarkdown = (text: string): string => clean(md.render(text))
export const renderInline = (text: string): string => clean(md.renderInline(text))

/** Markdown down to its words, for a card's summary. */
export const plainText = (text: string): string => text.replace(/[#*_`>[\]()!]/g, '').replace(/\s+/g, ' ').trim()
