import { afterEach, expect, it } from 'vitest'
import { renderFormula } from '@core/formula'
import { quoteSelectionText } from '@core/quote-selection'

const tex = String.raw`\lim_{h\to0}\frac{(3+h)^2-9}{h}=6`

function quote(range: Range): string {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return quoteSelectionText(selection)
}

afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren() })

it('quotes the selected numerator symbols without expanding to the whole fraction', () => {
  document.body.innerHTML = renderFormula(tex)
  const numerator = document.querySelector('mfrac > mrow')!
  const range = document.createRange()
  range.setStart(numerator.querySelector('mo')!.firstChild!, 0)
  range.setEnd(numerator.querySelector('mi')!.firstChild!, 1)
  expect(quote(range)).toBe('(3+h')
  range.selectNodeContents(document.querySelector('mfrac')!)
  expect(quote(range)).toBe(String.raw`\frac{(3+h)^{2}−9}{h}`)
})

it('uses the original TeX once when the whole visible expression is selected in either direction', () => {
  document.body.innerHTML = renderFormula(tex.replace('=', '\n=\n'))
  const first = document.querySelector('mi')!.firstChild!
  const last = document.querySelector('semantics > mrow > mn:last-child')!.firstChild!
  const selection = window.getSelection()!
  for (const [start, end] of [[first, last], [last, first]]) {
    selection.setBaseAndExtent(start, start === first ? 0 : 1, end, end === last ? 1 : 0)
    expect(quoteSelectionText(selection)).toBe(tex.replace('=', ' = '))
    expect(selection.anchorNode).toBe(start)
  }
})

it('preserves surrounding prose, line breaks, and partial text-node offsets across formulas', () => {
  document.body.innerHTML = '<p>Choose ' + renderFormula('x_i', 'inline') + ' first.<br>Then ' +
    renderFormula(String.raw`\text{input}+1`, 'inline') + ' ends here.</p>'
  const range = document.createRange()
  range.setStart(document.querySelector('p')!.firstChild!, 3)
  range.setEnd(document.querySelector('mtext')!.firstChild!, 3)
  expect(quote(range)).toBe('ose x_i first.\nThen inp')
})
