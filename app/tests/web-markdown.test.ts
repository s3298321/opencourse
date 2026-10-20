import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import githubDark from 'shiki/themes/github-dark.mjs'
import { citeAnswer } from '../src/core/sidechat/citations'
import { renderInline, renderMarkdown } from '../../server/web/src/lib/markdown'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

describe('web markdown highlighting', () => {
  it.each(['python', 'py', 'python3', 'Python'])('highlights %s without inline styles and preserves the source', (lang) => {
    const code = 'import asyncio\n\nasync def main():\n    await asyncio.sleep(1) # wait\n    return "<script>alert(1)</script>"\n'
    const doc = parse(renderMarkdown('```' + lang + '\n' + code + '```'))
    expect(doc.querySelector('pre.syntax-highlight code')?.textContent).toBe(code)
    expect(doc.querySelector('.syntax-f97583')?.textContent).toBe('import')
    expect(doc.querySelectorAll('[style], script')).toHaveLength(0)
    expect(doc.querySelectorAll('span[class^="syntax-"]').length).toBeGreaterThan(5)
  })

  it.each(['', 'unknown-language'])('escapes plain fences (%s)', (lang) => {
    const code = '<img src=x onerror=alert(1)>\n'
    const doc = parse(renderMarkdown('```' + lang + '\n' + code + '```'))
    expect(doc.querySelector('pre code')?.textContent).toBe(code)
    expect(doc.querySelectorAll('img, .syntax-highlight')).toHaveLength(0)
  })

  it('keeps inline code and safe external links', () => {
    expect(renderInline('use `await`')).toBe('use <code>await</code>')
    const link = parse(renderMarkdown('[docs](https://example.com)')).querySelector('a')!
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('nofollow ugc noopener noreferrer')
    expect(parse(renderMarkdown('[bad](javascript:alert(1))')).querySelector('a')).toBeNull()
  })

  it('covers every foreground color in the shared theme with external CSS', () => {
    const css = readFileSync(resolve(__dirname, '../../server/web/src/styles/syntax.css'), 'utf8')
    const colors = new Set([
      githubDark.colors!['editor.foreground'],
      ...githubDark.tokenColors!.map((token) => token.settings.foreground)
    ].filter((color): color is string => Boolean(color)))
    for (const color of colors) {
      expect(css).toContain(`.syntax-${color.slice(1).toLowerCase()} { color: ${color.toLowerCase()}; }`)
    }
  })
})

it('renders numbered citation pills with safe links matching the desktop renderer', () => {
  const cited = citeAnswer('Read [docs](https://example.com).', [{ url: 'https://example.com', title: 'Docs', start: -1, end: -1 }])
  const doc = parse(renderMarkdown(cited.markdown))
  expect(doc.querySelector('sup.cite a')?.textContent).toBe('1')
  expect(doc.querySelector('sup.cite a')?.getAttribute('target')).toBe('_blank')
  expect(doc.body.textContent).not.toContain('\uE000')
})
