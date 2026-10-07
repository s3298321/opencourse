import { beforeAll, describe, expect, it } from 'vitest'
import DOMPurify from 'dompurify'
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  ALLOWED_URI_REGEXP,
  createRenderer,
  type MarkdownRenderer
} from '@core/markdown'
import { CITE_MARK, citeAnswer } from '@core/sidechat/citations'

let md: MarkdownRenderer

beforeAll(async () => {
  md = await createRenderer()
}, 30_000)

describe('rendering', () => {
  it('renders commonmark', () => {
    expect(md.render('# Title\n\nSome **bold** text.')).toContain('<h1>Title</h1>')
  })

  it('renders tables', () => {
    const html = md.render('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  it('highlights python fences with shiki', () => {
    const html = md.render('```python\nasync def main():\n    await go()\n```')
    expect(html).toContain('class="shiki')
    expect(html).toContain('--shiki-dark')
  })

  it('highlights LLVM IR fences, under every alias a course uses', () => {
    // The JavaScript regex engine cannot run every TextMate grammar; this one
    // has to actually tokenize, not fall back to plain text.
    for (const lang of ['llvm', 'll', 'llvm-ir']) {
      const html = md.render('```' + lang + '\ndefine i32 @f(i32 %x) {\n  ret i32 %x\n}\n```')
      expect(html, lang).toContain('class="shiki')
      expect(html, lang).toMatch(/<span style="[^"]*--shiki-dark[^"]*">define<\/span>/)
    }
  })

  it('leaves unknown languages as plain code', () => {
    const html = md.render('```rust\nfn main() {}\n```')
    expect(html).toContain('<code')
    expect(html).not.toContain('shiki')
  })

  it('renders inline without wrapping in a paragraph', () => {
    expect(md.renderInline('use `await`')).toBe('use <code>await</code>')
  })
})

describe('sanitization', () => {
  const dom = (html: string): Document =>
    new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  it('escapes raw html instead of emitting elements', () => {
    const doc = dom(md.render('<script>alert(1)</script>\n\n<iframe src="http://evil"></iframe>'))
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('iframe')).toBeNull()
    // it survives as visible text, which is what a course author would want
    expect(doc.body.textContent).toContain('<script>alert(1)</script>')
  })

  it('emits no event-handler attributes', () => {
    const doc = dom(md.render('<img src=x onerror="alert(1)">\n\n![ok](opencourse://c/assets/a.png)'))
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.startsWith('on')).toBe(false)
      }
    }
  })

  it('never produces a javascript: link', () => {
    // eslint-disable-next-line no-script-url
    const doc = dom(md.render('[click](javascript:alert(1))\n\n[ok](https://python.org)'))
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('javascript:alert(1)')
    expect(hrefs).toContain('https://python.org')
  })

  it('keeps http links and opencourse asset urls', () => {
    expect(md.render('[docs](https://docs.python.org)')).toContain('https://docs.python.org')
    expect(md.render('![x](opencourse://course/assets/img/a.png)')).toContain('opencourse://course/assets/img/a.png')
  })
})

describe('the sanitizer configuration itself', () => {
  // markdown-it already escapes raw HTML, so drive DOMPurify directly to prove
  // the allowlist is the one we think it is.
  const clean = (html: string): string =>
    DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP })

  it('strips script, iframe, object and form elements', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style']) {
      expect(clean(`<${tag}>x</${tag}>`)).not.toContain(`<${tag}`)
    }
  })

  it('strips event handlers but keeps the element', () => {
    const out = clean('<p onclick="steal()">hi</p>')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('onclick')
  })

  it('strips links with schemes outside the allowlist', () => {
    // eslint-disable-next-line no-script-url
    expect(clean('<a href="javascript:x()">x</a>')).not.toContain('javascript')
    expect(clean('<a href="file:///etc/passwd">x</a>')).not.toContain('file:')
    expect(clean('<a href="https://python.org">x</a>')).toContain('https://python.org')
    expect(clean('<img src="opencourse://c/assets/a.png">')).toContain('opencourse://c/assets/a.png')
    for (const scheme of ['localcrs', 'pycrs']) {
      expect(clean(`<img src="${scheme}://c/assets/a.png">`)).not.toContain(`${scheme}:`)
    }
  })

  it('keeps the css custom properties shiki emits', () => {
    const out = clean('<span style="--shiki-light:#D73A49;--shiki-dark:#F97583">async</span>')
    expect(out).toContain('--shiki-light')
    expect(out).toContain('--shiki-dark')
  })
})

describe('side chat citation markers', () => {
  const url = 'https://docs.python.org/3/library/asyncio.html?utm_source=openai'

  it('renders a cited answer with a superscript pill linking to the page', () => {
    const { markdown } = citeAnswer(`Tasks run concurrently ([docs.python.org](${url})).`, [
      { url, title: 'asyncio — Python docs', start: 23, end: 23 + `([docs.python.org](${url}))`.length }
    ])
    const html = md.render(markdown)
    expect(html).toContain(
      '<p>Tasks run concurrently<sup class="cite"><a href="https://docs.python.org/3/library/asyncio.html?utm_source=openai" title="asyncio — Python docs">1</a></sup>.</p>'
    )
    expect(html).not.toContain(CITE_MARK)
  })

  it('drops a marker that did not end up in front of a link', () => {
    const html = md.render(`a \`${CITE_MARK}[1](<${url}>)\` b ${CITE_MARK} c`)
    expect(html).not.toContain(CITE_MARK)
    expect(html).not.toContain('class="cite"')
  })

  it('leaves the sanitizer the last word on what a marker links to', () => {
    // markdown-it refuses the link outright, so what is left is inert text.
    const html = md.render(`x${CITE_MARK}[1](javascript:alert(1)) y`)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('class="cite"')
  })

  it('does not touch an ordinary link', () => {
    expect(md.render('[1](https://example.com)')).toBe('<p><a href="https://example.com">1</a></p>\n')
  })
})
