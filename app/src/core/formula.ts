import katex from 'katex'
import { escapeHtml } from './html'

/** Only KaTeX produces markup here. Native MathML works with the web reader's
 * stylesheet policy and exposes the equation's structure to assistive tools. */
export function renderFormula(source: string, mode: 'display' | 'inline' = 'display'): string {
  let tex = source.trim()
  const display = mode === 'display'
  if (display && tex.startsWith('$$') && tex.endsWith('$$')) tex = tex.slice(2, -2).trim()
  else if (display && tex.startsWith('\\[') && tex.endsWith('\\]')) tex = tex.slice(2, -2).trim()

  try {
    const math = katex.renderToString(tex, {
      output: 'mathml', displayMode: display, trust: false, maxSize: 20
    })
    if (!display) return `<span class="course-inline-formula">${math}</span>`
    return `<span class="course-formula">${math}</span>`
  } catch (error) {
    const message = error instanceof katex.ParseError ? error.message : 'Unable to typeset this expression.'
    if (!display) return `<span class="formula-error" title="${escapeHtml(message)}">Invalid LaTeX: <code>${escapeHtml(tex)}</code></span>`
    return `<span class="course-formula formula-error"><strong>Invalid LaTeX</strong><code>${escapeHtml(tex)}</code><small>${escapeHtml(message)}</small></span>`
  }
}
