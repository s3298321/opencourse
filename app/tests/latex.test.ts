import { beforeAll, describe, expect, it } from 'vitest'
import { createRenderer, type MarkdownRenderer } from '@core/markdown'
import { renderFormula } from '@core/formula'
import { renderLessonText } from '../../server/web/src/lib/markdown'

const slope = String.raw`\text{slope} = \frac{\text{change in output}}{\text{change in input}} = \frac{f(b)-f(a)}{b-a}, \quad b\ne a.`
const dom = (html: string) => new DOMParser().parseFromString(html, 'text/html')
let md: MarkdownRenderer
beforeAll(async () => { md = await createRenderer() }, 30_000)

it('typesets bare and pasted equations as accessible display fractions', () => {
  for (const source of [slope, '$$' + slope + '$$', '\\[' + slope + '\\]']) {
    const doc = dom(renderFormula(source))
    expect(doc.querySelector('math[display=block]')?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(doc.querySelectorAll('mfrac')).toHaveLength(2)
    expect(doc.querySelector('annotation')?.textContent).toBe(slope)
  }
})

it('keeps invalid expressions readable and prevents authored markup and links', () => {
  const invalid = dom(renderFormula(String.raw`\notACommand{<img src=x onerror=alert(1)>}`))
  expect(invalid.querySelector('.formula-error')?.textContent).toContain('notACommand')
  expect(invalid.querySelector('img')).toBeNull()
  expect(dom(renderFormula(String.raw`\href{javascript:alert(1)}{x}`)).querySelector('[href]')).toBeNull()
})

describe.each([
  ['desktop', (text: string) => md.render(text, true)],
  ['web', renderLessonText]
] as const)('%s lesson Markdown', (_, render) => {
  it('keeps math inside sentences, emphasis, links and lists', () => {
    const doc = dom(render(String.raw`At **$x_i$**, evaluate [$f(x)$](https://example.org).

- Compare $\frac{1}{2}$ and $2$.`))
    expect([...doc.querySelectorAll('annotation')].map(el => el.textContent))
      .toEqual(['x_i', 'f(x)', String.raw`\frac{1}{2}`, '2'])
    expect(doc.querySelector('p strong msub')).toBeTruthy()
    expect(doc.querySelector('a math')).toBeTruthy()
    expect(doc.querySelector('li mfrac')).toBeTruthy()
    expect(doc.querySelector('math[display="block"], .course-formula')).toBeNull()
  })

  it('typesets TeX delimiters in replies, including lists, while preserving literal examples', () => {
    const source = String.raw`Evaluate \(f(x)\).

1. Then compute
   \[
   f(2) = \frac{4}{2}
   \]

Literal ` + '`\\(x\\)`' + '\n\n```tex\n\\[y\\]\n```'
    const doc = dom(render(source))
    expect(doc.querySelector('p .course-inline-formula annotation')?.textContent).toBe('f(x)')
    expect(doc.querySelector('li math[display="block"] mfrac')).toBeTruthy()
    expect(doc.querySelectorAll('math')).toHaveLength(2)
    expect([...doc.querySelectorAll('code')].map(node => node.textContent?.trim())).toEqual(['\\(x\\)', '\\[y\\]'])
  })

  it('keeps absolute-value bars inside math in table cells', () => {
    const values = ['0.1', '0.001', '0.000001']
    const rows = values.map(v => `| Within $${v}$ of $6$ | Choose any $h$ with $0<|h|<${v}$ |`)
    const doc = dom(render(['| Your requested accuracy | My guarantee |', '|---|---|', ...rows].join('\n')))
    expect([...doc.querySelectorAll('tbody tr')].map(row => row.children.length)).toEqual([2, 2, 2])
    expect([...doc.querySelectorAll('td:last-child annotation')].map(el => el.textContent))
      .toEqual(values.flatMap(v => ['h', `0<|h|<${v}`]))
  })

  it('protects pipes in math headers and nested tables while preserving Markdown escapes and literal examples', () => {
    const source = String.raw`> | \(|x|\) | Meaning |
> | --- | --- |
> | **$|y|$** | a\|b |
> | $\|z\|$ | ` + '`$p$`' + ' |\n\n' + '```md\n| $|x|$ | Meaning |\n| --- | --- |\n```'
    const doc = dom(render(source))
    expect(doc.querySelector('blockquote th annotation')?.textContent).toBe('|x|')
    expect([...doc.querySelectorAll('td annotation')].map(el => el.textContent)).toEqual(['|y|', '|z|'])
    expect(doc.querySelector('td:nth-child(2)')?.textContent).toBe('a|b')
    expect(doc.querySelector('td code')?.textContent).toBe('$p$')
    expect(doc.querySelector('pre code')?.textContent).toContain('| $|x|$ | Meaning |')
    const heading = dom(render('Magnitude $|x|$\n---'))
    expect(heading.querySelector('h2 annotation')?.textContent).toBe('|x|')
  })

  it('can resume at a new inline opener in partial text and preserves image label notation', () => {
    const doc = dom(render(String.raw`Partial \(unfinished; next \(x^2\).

![Plot of \(x^2\)](https://example.org/plot.png)`))
    expect(doc.querySelectorAll('math')).toHaveLength(1)
    expect(doc.querySelector('annotation')?.textContent).toBe('x^2')
    expect(doc.querySelector('img')?.alt).toBe(String.raw`Plot of \(x^2\)`)
  })

  it('keeps prices, escapes, code, image labels and unmatched dollars literal', () => {
    const source = ['Pay $5–$10 or $20 per item. Then use $f(x)$.',
      String.raw`Literal \$x\$, code ` + '`$x$`' + ' and unmatched $z.',
      '![The $x$ axis](https://example.org/axis.png)',
      'Do not pair $x\nwith y$.', '```latex\n$x$\n```', '    $x$'].join('\n\n')
    const doc = dom(render(source))
    expect(doc.querySelectorAll('math')).toHaveLength(1)
    expect(doc.querySelector('annotation')?.textContent).toBe('f(x)')
    expect(doc.body.textContent).toContain('Pay $5–$10 or $20 per item.')
    expect(doc.body.textContent).toContain('Literal $x$, code $x$ and unmatched $z.')
    expect(doc.querySelector('img')?.alt).toBe('The $x$ axis')
    expect(doc.querySelectorAll('code')).toHaveLength(3)
  })

  it('supports escaped dollars inside math and keeps malformed expressions inline and inert', () => {
    const doc = dom(render(String.raw`Cost $\$5$; broken $\notACommand{<img src=x>}$; valid $x^2$.`))
    expect(doc.querySelector('annotation')?.textContent).toBe(String.raw`\$5`)
    expect(doc.querySelector('p span.formula-error code')?.textContent).toContain('<img src=x>')
    expect(doc.querySelector('p msup')).toBeTruthy()
    expect(doc.querySelector('img, script, div')).toBeNull()
  })

  it('typesets neighboring equations while preserving prose, links and code', () => {
    const source = ['Compare [the inputs][ref]', '$$' + slope + '$$', '$$', 'x_1^2', '$$', '**After**',
      '', '```tex', '$$x$$', '```', '', '    $$y$$', '', '`$$z$$` or $5.', '', '[ref]: https://example.org'].join('\n')
    const doc = dom(render(source))
    expect(doc.querySelectorAll('math')).toHaveLength(2)
    expect(doc.querySelectorAll('mfrac')).toHaveLength(2)
    expect(doc.querySelector('msubsup')).toBeTruthy()
    expect(doc.querySelector('strong')?.textContent).toBe('After')
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.org')
    expect([...doc.querySelectorAll('code')].map(el => el.textContent?.trim())).toEqual(['$$x$$', '$$y$$', '$$z$$'])
  })

  it('leaves unclosed delimiters literal and renders the next valid equation', () => {
    const doc = dom(render('$$unfinished\n\nNext line\n$$1+2$$'))
    expect(doc.querySelector('p')?.textContent).toBe('$$unfinished')
    expect(doc.querySelectorAll('math')).toHaveLength(1)
  })

  it('keeps a standalone equals sign inside display math and preserves Markdown headings outside it', () => {
    const tex = String.raw`\underbrace{\frac{(3+h)^2-9}{h}}_{\text{undefined at }h=0}
=
\underbrace{6+h}_{\text{defined at }h=0}`
    const doc = dom(render(['The limit', '===', '', '$$', tex, '$$'].join('\n')))
    expect([...doc.querySelectorAll('h1')].map(el => el.textContent)).toEqual(['The limit'])
    expect(doc.querySelector('math[display="block"] annotation')?.textContent).toBe(tex)
  })
})

describe.each([
  ['desktop', (text: string) => md.renderInline(text, true)],
  ['web', (text: string) => renderLessonText(text, true)]
] as const)('%s quiz choices', (_, render) => {
  it('typesets math inside a choice while preserving inline formatting and literal dollars', () => {
    const doc = dom(render('**Case A:** $x_1$ costs $5; `$x$` is source.'))
    expect(doc.querySelector('strong')?.textContent).toBe('Case A:')
    expect(doc.querySelector('msub')).toBeTruthy()
    expect(doc.querySelector('code')?.textContent).toBe('$x$')
    expect(doc.body.textContent).toContain('costs $5')
    expect(doc.querySelector('p, div, math[display="block"]')).toBeNull()
  })

  it('renders a standalone display choice as phrasing content inside its label', () => {
    const doc = dom(render(String.raw`$$\frac{1}{2}$$`))
    expect(doc.querySelector('span.course-formula math[display="block"] mfrac')).toBeTruthy()
    expect(doc.querySelector('p, div, pre')).toBeNull()
  })
})
