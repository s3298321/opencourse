import type { MarkdownIt, StateCore, StateInline, Token } from 'markdown-it'
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
        token.meta = { mathStart: start }
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

// Markdown-it splits table cells before running inline rules. Escape bare pipes
// in recognized math for that split; the table rule removes the added backslash.
function protectTableMath(state: StateCore): void {
  if (state.inlineMode || !state.env.lessonMath || !state.src.includes('|') || !state.src.includes('-')) return
  const lines = state.src.split('\n')
  const candidates = lines.map(line => {
    if (!line.includes('|') || !(line.includes('$') || line.includes('\\('))) return line
    const tokens: Token[] = []
    state.md.inline.parse(line, state.md, state.env, tokens)
    const pipes = new Set<number>()
    for (const token of tokens) {
      const start = token.meta?.mathStart
      if (token.type !== 'lesson_inline_formula' || typeof start !== 'number') continue
      for (const match of token.content.matchAll(/(?<!\\)\|/g)) pipes.add(start + match.index)
    }
    return pipes.size ? line.replace(/\|/g, (pipe, offset) => pipes.has(offset) ? '\\|' : pipe) : line
  })
  if (candidates.every((line, i) => line === lines[i])) return

  // Only apply the escapes to rows the block parser recognizes as a table.
  // Identical source in prose, a fenced example or indented code stays literal.
  const blocks: Token[] = []
  state.md.block.parse(candidates.join('\n'), state.md, { ...state.env }, blocks)
  for (const block of blocks) {
    if (block.type !== 'table_open' || !block.map) continue
    const [start, end] = block.map
    // Bars belonging only to math do not turn an underlined heading into a one-column table.
    if (!/(?<!\\)\|/.test(candidates[start]) && !lines[start + 1].includes('|')) continue
    for (let row = start; row < end; row++) lines[row] = candidates[row]
  }
  state.src = lines.join('\n')
}

export function createLessonMarkdown(md: MarkdownIt, clean: (html: string) => string): (source: string, inline?: boolean) => string {
  md.core.ruler.before('block', 'lesson_table_math', protectTableMath)
  // A line containing only "=" can be part of an equation or a Markdown heading underline.
  md.block.ruler.before('lheading', 'lesson_formula', (state, start, end, silent) => {
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
