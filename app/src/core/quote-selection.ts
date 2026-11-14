/** Chromium's Selection.toString() inserts layout breaks between MathML
 * tokens. Read the selected symbols from the DOM instead. */
function mathFragment(node: Node, range: Range): string {
  if (!range.intersectsNode(node)) return ''
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').slice(
      node === range.startContainer ? range.startOffset : 0,
      node === range.endContainer ? range.endOffset : undefined
    )
  }
  const parts = Array.from(node.childNodes, child => mathFragment(child, range))
  const [base, arg, upper] = parts
  switch (node.nodeName.toLowerCase()) {
    case 'mfrac': if (base && arg) return `\\frac{${base}}{${arg}}`; break
    case 'msub': case 'munder': if (base && arg) return `${base}_{${arg}}`; break
    case 'msup': case 'mover': if (base && arg) return `${base}^{${arg}}`; break
    case 'msubsup': case 'munderover':
      if (base) return base + (arg ? `_{${arg}}` : '') + (upper ? `^{${upper}}` : '')
      break
  }
  return parts.join('')
}

function selectedFormula(math: Element, range: Range): string {
  const presentation = math.querySelector('semantics')?.firstElementChild ?? math
  if (!range.intersectsNode(presentation)) return ''
  const selected = math.ownerDocument.createRange()
  selected.selectNodeContents(presentation)
  if (range.compareBoundaryPoints(Range.START_TO_START, selected) > 0) selected.setStart(range.startContainer, range.startOffset)
  if (range.compareBoundaryPoints(Range.END_TO_END, selected) < 0) selected.setEnd(range.endContainer, range.endOffset)
  if (selected.toString() === presentation.textContent) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    // A newline terminates a TeX comment. Other source line breaks are just spacing.
    if (tex) return tex.includes('%') ? tex : tex.replace(/\s*\n\s*/g, ' ')
  }
  return mathFragment(presentation, selected).replace(/[\u2061\u2062]/g, '')
}

export function quoteSelectionText(selection: Selection | null): string {
  if (!selection?.rangeCount || selection.isCollapsed) return ''
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer
  const ancestor = node instanceof Element ? node : node.parentElement
  const within = ancestor?.closest('math')
  if (within) return selectedFormula(within, range)
  const formulas = Array.from(ancestor?.querySelectorAll('math') ?? []).filter(math => range.intersectsNode(math))
  if (!formulas.length) return selection.toString()

  // Change only the detached copy. The original range still anchors the offer
  // and highlights exactly what the reader selected.
  const copy = range.cloneContents()
  copy.querySelectorAll('math').forEach((math, index) => math.replaceWith(selectedFormula(formulas[index], range)))
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n')
  for (const cell of copy.querySelectorAll('th:not(:last-child), td:not(:last-child)')) cell.append('\t')
  for (const block of copy.querySelectorAll('p, pre, li, tr, h1, h2, h3, h4, h5, h6, .course-formula')) block.append('\n')
  return (copy.textContent ?? '').trim()
}
