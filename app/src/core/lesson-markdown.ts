import type { MarkdownIt, StateInline } from 'markdown-it'
import { renderFormula } from './formula'

function inlineFormula(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state
  if (!state.env?.lessonMath) return false
  const dollar = src[pos] === '$'
  if (!dollar && !src.startsWith('\\(', pos)) return false
  const start = pos + (dollar ? 1 : 2)
  if (start >= posMax || (dollar && (src[pos - 1] === '$' || src[start] === '$' || /\s/.test(src[start])))) return false

  const close = dollar ? '$' : '\\)'
  for (let end = start; end < posMax; end++) {
    const ch = src[end]
    if (ch === '\n' || ch === '`') break
    if (end + close.length <= posMax && src.startsWith(close, end)) {
      // A dollar followed by a digit usually starts a price.
      if (end === start || (dollar && (/\s/.test(src[end - 1]) || /[\d$]/.test(src[end + 1] ?? '')))) break
      if (!silent) {
        const token = state.push('lesson_inline_formula', '', 0)
        token.content = src.slice(start, end)
        token.markup = src.slice(pos, start)
      }
      state.pos = end + close.length
      return true
    }
    if (ch === '\\') {
      if (!dollar && src[end + 1] === '(') break
      if (src[end + 1] !== '\n') end++
    }
  }
  return false
}

export function createLessonMarkdown(md: MarkdownIt, clean: (html: string) => string): (source: string, inline?: boolean) => string {
  md.block.ruler.before('paragraph', 'lesson_formula', (state, start, end, silent) => {
    if (!state.env?.lessonMath || state.sCount[start] - state.blkIndent >= 4) return false
    const lineText = (i: number): string => state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]).trimEnd()
    const opening = lineText(start)
    const close = opening.startsWith('$$') ? '$$' : opening.startsWith('\\[') ? '\\]' : null
    if (!close) return false
    let last = start
    if (!opening.slice(2).endsWith(close)) {
      // An unmatched delimiter must not consume the next paragraph or code example.
      do {
        last++
        if (last >= end || state.isEmpty(last) || state.sCount[last] < state.blkIndent) return false
        const line = lineText(last)
        if (/^(?:`{3,}|~{3,})/.test(line) || ((line.startsWith('$$') || line.startsWith('\\[')) && line !== close)) return false
      } while (!lineText(last).endsWith(close))
    }
    if (!silent) {
      const token = state.push('lesson_formula', '', 0)
      token.content = state.getLines(start, last + 1, state.blkIndent, false).trim()
      token.map = [start, last + 1]
      state.line = last + 1
    }
    return true
  }, { alt: ['paragraph'] })

  md.inline.ruler.before('text', 'lesson_inline_formula', inlineFormula)
  md.renderer.rules.lesson_inline_formula = (tokens, i) =>
    `<span class="lesson-math-source">${md.utils.escapeHtml(tokens[i].content)}</span>`
  md.renderer.rules.lesson_formula = (tokens, i) =>
    `<div class="lesson-math-source">${md.utils.escapeHtml(tokens[i].content)}</div>`

  // Markdown-it flattens image labels to plain text. Keep the authored notation there.
  const asText = md.renderer.renderInlineAsText.bind(md.renderer)
  md.renderer.renderInlineAsText = (tokens, options, env) => tokens.map(token => {
    if (token.type !== 'lesson_inline_formula') return asText([token], options, env)
    return token.markup + token.content + (token.markup === '$' ? '$' : '\\)')
  }).join('')

  return (source, inline = false) => {
    const env = { lessonMath: true }
    // A choice label can consist of a display equation. Use the same delimiter
    // rules as a lesson, while keeping ordinary choices free of paragraph tags.
    if (inline && /^(?:\$\$|\\\[)/.test(source.trimStart())) {
      const tokens = md.parse(source, env)
      if (tokens.length === 1 && tokens[0].type === 'lesson_formula') return renderFormula(tokens[0].content)
    }
    const html = clean(inline ? md.renderInline(source, env) : md.render(source, env))
    if (!html.includes('class="lesson-math-source"')) return html

    // Sanitize the complete Markdown tree first so links and emphasis stay intact.
    // Only the parsed formula elements receive markup produced by KaTeX.
    const template = document.createElement('template')
    template.innerHTML = html
    for (const element of template.content.querySelectorAll('.lesson-math-source')) {
      element.outerHTML = renderFormula(element.textContent ?? '', element.tagName === 'SPAN' ? 'inline' : 'display')
    }
    return template.innerHTML
  }
}
