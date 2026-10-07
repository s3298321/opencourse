/**
 * Web citations, pure: from OpenAI's annotations to numbered markers and a
 * source list, and the guesses about which models may search.
 *
 * The offsets are the part nobody documents, so most of this is about them -
 * UTF-16 against code points, a span that covers the link against one that
 * covers the claim, and offsets that hold nothing at all. In every case the
 * page must still be listed.
 */
import { describe, expect, it } from 'vitest'
import { CITE_MARK, citeAnswer, hostOf, normalizeCitations, shortTitle } from '@core/sidechat/citations'
import { fetchableUrl, iconLinks, isFetchableHost, sniffImage } from '@core/sidechat/favicon'
import { webSearchFor } from '@core/sidechat/models'
import { SIDE_CHAT_INSTRUCTIONS, sideChatInstructions } from '@core/sidechat/prompt'
import { normalizePreferences } from '@core/preferences'
import type { ChatCitation } from '@core/types'

const PY = 'https://docs.python.org/3/library/asyncio.html?utm_source=openai'
const PEP = 'https://peps.python.org/pep-0779/?utm_source=openai'

/** The citation as OpenAI reports it: a span covering the inline link it wrote. */
function cite(text: string, url: string, title: string, occurrence = 0): ChatCitation {
  const link = `([${hostOf(url)}](${url}))`
  let start = -1
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(link, start + 1)
  if (start === -1) throw new Error('no such link in the text')
  return { url, title, start, end: start + link.length }
}

/** What the markers say, without the link syntax around them. */
function markers(markdown: string): string[] {
  return [...markdown.matchAll(new RegExp(`${CITE_MARK}\\[(\\d+)\\]\\(<([^>]*)>`, 'g'))].map((m) => `${m[1]}:${m[2]}`)
}

describe('citeAnswer', () => {
  it('replaces the inline link with a numbered marker against the word it supports', () => {
    const text = `Python 3.14 ships free threading ([docs.python.org](${PY})). Done.`
    const { markdown, sources } = citeAnswer(text, [cite(text, PY, 'asyncio — Python 3.14 documentation')])
    expect(markdown).toBe(
      `Python 3.14 ships free threading${CITE_MARK}[1](<${PY}> "asyncio — Python 3.14 documentation"). Done.`
    )
    expect(sources).toEqual([{ n: 1, url: PY, title: 'asyncio — Python 3.14 documentation', host: 'docs.python.org' }])
  })

  it('leaves an answer without citations exactly as it was', () => {
    const text = 'No web here ([a](https://a.example)).'
    expect(citeAnswer(text, undefined)).toEqual({ markdown: text, sources: [] })
    expect(citeAnswer(text, [])).toEqual({ markdown: text, sources: [] })
  })

  it('numbers pages in the order the text first cites them, and one page once', () => {
    const text =
      `First ([peps.python.org](${PEP})). Second ([docs.python.org](${PY})). ` +
      `Again ([peps.python.org](${PEP})).`
    // Given out of order, the way nothing promises they will not be.
    const citations = [cite(text, PY, 'Docs'), cite(text, PEP, 'PEP 779', 1), cite(text, PEP, 'PEP 779')]
    const { markdown, sources } = citeAnswer(text, citations)
    expect(sources.map((s) => [s.n, s.host])).toEqual([[1, 'peps.python.org'], [2, 'docs.python.org']])
    expect(markers(markdown)).toEqual([`1:${PEP}`, `2:${PY}`, `1:${PEP}`])
    expect(markdown).not.toContain('](https://')
  })

  it('treats a page with and without the utm tag as one source', () => {
    const bare = 'https://docs.python.org/3/library/asyncio.html'
    const text = `A ([docs.python.org](${PY})). B ([docs.python.org](${bare})).`
    const { sources, markdown } = citeAnswer(text, [cite(text, PY, 'Docs'), cite(text, bare, 'Docs')])
    expect(sources).toHaveLength(1)
    expect(markers(markdown).map((m) => m.split(':')[0])).toEqual(['1', '1'])
  })

  it('reads code-point offsets when an emoji puts UTF-16 off by one', () => {
    const text = `Fast 🚀 now ([docs.python.org](${PY})).`
    const exact = cite(text, PY, 'Docs')
    // What a server counting characters would report: one less per astral char before.
    const points = { ...exact, start: exact.start - 1, end: exact.end - 1 }
    const { markdown } = citeAnswer(text, [points])
    expect(markdown.startsWith(`Fast 🚀 now${CITE_MARK}[1]`)).toBe(true)
    expect(markdown.endsWith('.')).toBe(true)
  })

  it('finds the link by its URL when the offsets point nowhere useful', () => {
    const text = `Something true ([docs.python.org](${PY})).`
    const { markdown, sources } = citeAnswer(text, [{ url: PY, title: 'Docs', start: 999, end: 1200 }])
    expect(markers(markdown)).toEqual([`1:${PY}`])
    expect(sources).toHaveLength(1)
  })

  it('puts a marker after the claim when the span covers prose rather than a link', () => {
    const text = 'Python 3.14 was released in October 2025. It has more.'
    const end = text.indexOf('2025.') + '2025.'.length
    const { markdown } = citeAnswer(text, [{ url: PY, title: 'Docs', start: 0, end }])
    expect(markdown).toBe(`Python 3.14 was released in October 2025.${CITE_MARK}[1](<${PY}> "Docs") It has more.`)
  })

  it('never puts a marker inside a word', () => {
    const text = 'The event loop runs tasks.'
    const { markdown } = citeAnswer(text, [{ url: PY, title: 'Docs', start: 0, end: 6 }])
    expect(markdown.startsWith(`The event${CITE_MARK}[1]`)).toBe(true)
  })

  it('still lists a page it could not place anywhere', () => {
    const text = 'Nothing here links anywhere.'
    const { markdown, sources } = citeAnswer(text, [{ url: PY, title: 'Docs', start: -1, end: -1 }])
    expect(markdown).toBe(text)
    expect(sources).toEqual([{ n: 1, url: PY, title: 'Docs', host: 'docs.python.org' }])
  })

  it('gives two pages that support one sentence a marker each, in order', () => {
    const text = 'One claim. Next.'
    const end = text.indexOf('.') + 1
    const { markdown } = citeAnswer(text, [
      { url: PY, title: 'Docs', start: 0, end },
      { url: PEP, title: 'PEP', start: 0, end }
    ])
    expect(markers(markdown).map((m) => m.split(':')[0])).toEqual(['1', '2'])
    expect(markdown.indexOf(`${CITE_MARK}[1]`)).toBeLessThan(markdown.indexOf(`${CITE_MARK}[2]`))
  })

  it('collapses a parenthesised group of links into adjacent markers', () => {
    const a = 'https://a.example/x'
    const b = 'https://b.example/y'
    const text = `Claim ([a.example](${a}), [b.example](${b})).`
    const { markdown } = citeAnswer(text, [
      { url: a, title: 'A', start: -1, end: -1 },
      { url: b, title: 'B', start: -1, end: -1 }
    ])
    expect(markdown).toBe(`Claim${CITE_MARK}[1](<${a}> "A")${CITE_MARK}[2](<${b}> "B").`)
  })

  it('keeps one marker for the same page cited twice in a row', () => {
    const text = `Claim ([docs.python.org](${PY})) ([docs.python.org](${PY})).`
    const { markdown } = citeAnswer(text, [cite(text, PY, 'Docs'), cite(text, PY, 'Docs', 1)])
    expect(markers(markdown)).toEqual([`1:${PY}`])
  })

  it('handles a URL with parentheses in it, the way Wikipedia writes them', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Python_(programming_language)'
    const text = `A language ([en.wikipedia.org](${wiki})).`
    const { markdown } = citeAnswer(text, [cite(text, wiki, 'Python (programming language) - Wikipedia')])
    expect(markdown).toBe(`A language${CITE_MARK}[1](<${wiki}> "Python (programming language) - Wikipedia").`)
  })

  it('escapes a title so it cannot end the link early', () => {
    const text = `X ([docs.python.org](${PY})).`
    const { markdown } = citeAnswer(text, [cite(text, PY, 'Say "hi" \\ there')])
    expect(markdown).toContain('"Say \\"hi\\" \\\\ there")')
  })

  it('does not let a private-use character already in the answer forge a marker', () => {
    const text = `${CITE_MARK}[9](javascript:alert(1)) and real ([docs.python.org](${PY})).`
    const { markdown } = citeAnswer(text, [cite(text, PY, 'Docs')])
    expect(markers(markdown)).toEqual([`1:${PY}`])
    expect(markdown.startsWith('​[9]')).toBe(true)
  })
})

describe('normalizeCitations', () => {
  it('keeps http(s) pages and drops everything else', () => {
    const kept = normalizeCitations([
      { url: PY, title: ' Docs ', start: 1, end: 5 },
      { url: 'javascript:alert(1)', title: 'x', start: 0, end: 1 },
      { url: 'ftp://files.example/a', title: 'x', start: 0, end: 1 },
      { url: 'not a url', title: 'x' },
      null,
      'nope',
      { title: 'no url' }
    ])
    expect(kept).toEqual([{ url: PY, title: 'Docs', start: 1, end: 5 }])
  })

  it('reads offsets that are not offsets as "unplaced"', () => {
    expect(normalizeCitations([{ url: PY, start: 5, end: 2 }])[0]).toMatchObject({ start: -1, end: -1, title: '' })
    expect(normalizeCitations([{ url: PY, start: '1', end: 2 }])[0]).toMatchObject({ start: -1, end: -1 })
  })

  it('caps the list and the titles', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ url: `https://e${i}.example/`, title: 'x'.repeat(500), start: 0, end: 1 }))
    const kept = normalizeCitations(many)
    expect(kept).toHaveLength(50)
    expect(kept[0]!.title).toHaveLength(300)
  })

  it('reads anything that is not a list as no citations', () => {
    expect(normalizeCitations(null)).toEqual([])
    expect(normalizeCitations({ url: PY })).toEqual([])
  })
})

describe('shortTitle', () => {
  it('drops the site name the title ends with', () => {
    expect(shortTitle('asyncio — Asynchronous I/O — Python 3.13 documentation', PY)).toBe('asyncio — Asynchronous I/O')
    expect(shortTitle('Using promises | MDN', 'https://developer.mozilla.org/x')).toBe('Using promises')
  })

  it('keeps a short title whole rather than leave it saying nothing', () => {
    expect(shortTitle('PEP 8 - Style', PEP)).toBe('PEP 8 - Style')
  })

  it('cuts a long title at a word with an ellipsis', () => {
    const title = 'An extremely long article title that goes on and on about the event loop and its many tasks'
    const short = shortTitle(title, PY)
    expect(short.length).toBeLessThanOrEqual(60)
    expect(short.endsWith('…')).toBe(true)
    expect(title.startsWith(short.slice(0, -1))).toBe(true)
    expect(short.at(-2)).not.toBe(' ')
  })

  it('names a page with no title by its site and last path segment', () => {
    expect(shortTitle('', 'https://www.example.com/docs/getting-started')).toBe('example.com › getting-started')
    expect(shortTitle('https://example.com/a', 'https://example.com/a')).toBe('example.com › a')
    expect(shortTitle('', 'https://example.com/')).toBe('example.com')
  })
})

describe('webSearchFor', () => {
  it('offers search to the gpt-5 family and later, but not gpt-5 at minimal', () => {
    expect(webSearchFor('gpt-5', null)).toBe(true)
    expect(webSearchFor('gpt-5', 'minimal')).toBe(false)
    expect(webSearchFor('gpt-5-mini', 'low')).toBe(true)
    expect(webSearchFor('gpt-5.1', 'none')).toBe(true)
    expect(webSearchFor('gpt-5.6-terra', null)).toBe(true)
    expect(webSearchFor('gpt-6', 'high')).toBe(true)
  })

  it('knows the older models that take it and the ones that do not', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini', 'gpt-4.1-2025-04-14']) {
      expect(webSearchFor(id, null), id).toBe(true)
    }
    for (const id of ['gpt-4.1-nano', 'gpt-5-nano', 'o1', 'o1-mini', 'o3-mini', 'gpt-5-chat-latest', 'gpt-4', 'gpt-3.5-turbo']) {
      expect(webSearchFor(id, null), id).toBe(false)
    }
  })

  it('offers nothing to an id it does not recognise', () => {
    expect(webSearchFor('mystery-model', null)).toBe(false)
    expect(webSearchFor('', null)).toBe(false)
  })
})

describe('the side chat prompt and the search switch', () => {
  it('says it cannot look anything up unless search is on', () => {
    expect(sideChatInstructions(false)).toBe(SIDE_CHAT_INSTRUCTIONS)
    expect(SIDE_CHAT_INSTRUCTIONS).toContain('You have no way to look anything up.')
    const searching = sideChatInstructions(true)
    expect(searching).not.toContain('no way to look anything up')
    expect(searching).toContain('You can search the web')
    expect(searching).toContain('Never search for what the lesson already explains.')
  })

  it('reads only a literal true as consent to search', () => {
    expect(normalizePreferences({ webSearch: true })).toEqual({ webSearch: true })
    for (const value of [false, 'true', 1, 'yes', null]) {
      expect(normalizePreferences({ webSearch: value })).toEqual({})
    }
    expect(normalizePreferences({ chatModels: ['gpt-5.1'], webSearch: true })).toEqual({
      chatModels: ['gpt-5.1'],
      webSearch: true
    })
  })
})

describe('favicon rules', () => {
  it('fetches from public names only', () => {
    for (const host of ['docs.python.org', 'example.com', 'a-b.co.uk', 'xn--bcher-kva.example']) {
      expect(isFetchableHost(host), host).toBe(true)
    }
    for (const host of [
      'localhost', 'printer.local', 'router.lan', 'box.home.arpa', 'app.localhost', 'intranet',
      '127.0.0.1', '192.168.1.1', '10.0.0.1', '[::1]', '::1', 'fe80::1', '-bad.example', 'a..b', 'under_score.example', ''
    ]) {
      expect(isFetchableHost(host), host).toBe(false)
    }
  })

  it('follows only https to a fetchable host, with no credentials in it', () => {
    expect(fetchableUrl('https://example.com/favicon.ico')?.hostname).toBe('example.com')
    expect(fetchableUrl('/icon.png', 'https://example.com/a/')?.toString()).toBe('https://example.com/icon.png')
    expect(fetchableUrl('http://example.com/favicon.ico')).toBeNull()
    expect(fetchableUrl('https://192.168.0.1/favicon.ico')).toBeNull()
    expect(fetchableUrl('https://user:pw@example.com/')).toBeNull()
    expect(fetchableUrl('javascript:alert(1)')).toBeNull()
  })

  it('knows an image by its bytes, not its label', () => {
    expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon')
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png')
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(sniffImage(new TextEncoder().encode('<!doctype html><html>not an icon'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  it('reads a page for its icon links, best first, resolved and filtered', () => {
    const html = `<head>
      <link rel="stylesheet" href="/site.css">
      <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
      <link rel='icon' type='image/png' sizes='32x32' href='/icon-32.png?v=1&amp;x=2'>
      <link rel="icon" href="http://insecure.example/icon.png">
      <link rel="shortcut icon" href="https://192.168.1.1/evil.ico">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">
    </head>`
    expect(iconLinks(html, 'https://example.com/')).toEqual([
      'https://example.com/icon-32.png?v=1&x=2',
      'data:image/png;base64,iVBORw0KGgo=',
      'https://example.com/apple.png'
    ])
  })
})
