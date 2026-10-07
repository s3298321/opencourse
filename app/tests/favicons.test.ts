/**
 * The favicon fetcher, with Electron's net.request replaced by a fake web we
 * control - because what matters here is what it refuses to do: follow a
 * redirect into the local network, keep an oversized or non-image body, ask
 * twice for an icon it already has, or remember an outage as a miss.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-favicons-'))
let dataDir = join(root, 'data')

interface Route {
  status?: number
  body?: Uint8Array | string
  redirect?: string
  error?: boolean
}
/** The fake web: absolute URL to what answers there. Anything else is a 404. */
let routes: Record<string, Route> = {}
let requested: string[] = []

type Handler = (...args: unknown[]) => void

function emitter(): { on: (event: string, fn: Handler) => unknown; emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Handler[]>()
  return {
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    emit: (event, ...args) => (handlers.get(event) ?? []).forEach((fn) => fn(...args))
  }
}

/** Enough of a ClientRequest: redirect, response, error, abort - asynchronously, like the real one. */
function fakeRequest(options: { url: string }): unknown {
  const events = emitter()
  let url = options.url
  let aborted = false
  let followed = false
  const respond = (status: number, body: Uint8Array | string): void => {
    const response = emitter()
    events.emit('response', Object.assign(response, { statusCode: status, headers: {} }))
    setTimeout(() => {
      const bytes = Buffer.from(body)
      // In two chunks, so a size limit is hit partway like it would be.
      for (const chunk of [bytes.subarray(0, bytes.length >> 1), bytes.subarray(bytes.length >> 1)]) {
        if (aborted) return
        response.emit('data', chunk)
      }
      if (!aborted) response.emit('end')
    }, 0)
  }
  const serve = (): void => {
    requested.push(url)
    const route = routes[url]
    if (!route) return respond(404, 'not found')
    if (route.error) return events.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
    if (route.redirect) {
      followed = false
      events.emit('redirect', 301, 'GET', route.redirect, {})
      if (!followed || aborted) return
      url = route.redirect
      setTimeout(serve, 0)
      return
    }
    respond(route.status ?? 200, route.body ?? '')
  }
  const request = {
    on: (event: string, fn: Handler) => {
      events.on(event, fn)
      return request
    },
    setHeader: () => undefined,
    followRedirect: () => {
      followed = true
    },
    abort: () => {
      if (aborted) return
      aborted = true
      events.emit('abort')
    },
    end: () => setTimeout(serve, 0)
  }
  return request
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false,
    on: () => undefined
  },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { request: (options: { url: string }) => fakeRequest(options) }
}))

const { createUser, deleteUser, listUsers } = await import('../src/main/users')
const { userFaviconDir } = await import('../src/main/paths')
const { iconFor, iconsFor } = await import('../src/main/favicons')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>'
const dataUrl = (type: string, bytes: Uint8Array | string): string =>
  `data:${type};base64,${Buffer.from(bytes).toString('base64')}`

let n = 0
beforeEach(() => {
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  routes = {}
  requested = []
  delete process.env['OPENCOURSE_SMOKE']
  delete process.env['OPENCOURSE_SHOTS']
  createUser('Ada')
})

const cacheFiles = (): string[] => {
  try {
    return readdirSync(userFaviconDir(listUsers()[0]!.id))
  } catch {
    return []
  }
}

describe('finding an icon', () => {
  it('takes /favicon.ico when the site has one, and asks for nothing else', async () => {
    routes['https://example.com/favicon.ico'] = { body: ICO }
    expect(await iconFor('example.com')).toBe(dataUrl('image/x-icon', ICO))
    expect(requested).toEqual(['https://example.com/favicon.ico'])
  })

  it('falls back to the icon the home page declares', async () => {
    routes['https://example.com/'] = {
      body: '<html><head><link rel="icon" type="image/svg+xml" href="/static/icon.svg"></head></html>'
    }
    routes['https://example.com/static/icon.svg'] = { body: SVG }
    expect(await iconFor('example.com')).toBe(dataUrl('image/svg+xml', SVG))
    expect(requested).toEqual([
      'https://example.com/favicon.ico',
      'https://example.com/',
      'https://example.com/static/icon.svg'
    ])
  })

  it('follows a redirect to another public host', async () => {
    routes['https://example.com/favicon.ico'] = { redirect: 'https://www.example.com/favicon.ico' }
    routes['https://www.example.com/favicon.ico'] = { body: PNG }
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
  })

  it('will not follow a redirect into the local network, or onto plain http', async () => {
    routes['https://example.com/favicon.ico'] = { redirect: 'https://192.168.1.1/favicon.ico' }
    routes['https://example.com/'] = { redirect: 'http://example.com/' }
    routes['https://192.168.1.1/favicon.ico'] = { body: PNG }
    expect(await iconFor('example.com')).toBeNull()
    expect(requested).not.toContain('https://192.168.1.1/favicon.ico')
    expect(requested).not.toContain('http://example.com/')
  })

  it('stops after three redirects', async () => {
    for (let i = 0; i < 6; i += 1) {
      routes[`https://example.com/${i === 0 ? 'favicon.ico' : `r${i}`}`] = { redirect: `https://example.com/r${i + 1}` }
    }
    routes['https://example.com/r6'] = { body: PNG }
    expect(await iconFor('example.com')).toBeNull()
    expect(requested).not.toContain('https://example.com/r5')
  })

  it('never asks a host that is not a public name', async () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.8', 'printer.local', 'router.lan', 'intranet']) {
      expect(await iconFor(host), host).toBeNull()
    }
    expect(requested).toEqual([])
  })

  it('refuses a body that is not an image, whatever it was served as', async () => {
    routes['https://example.com/favicon.ico'] = { body: '<!doctype html><title>Soft 404</title>' }
    expect(await iconFor('example.com')).toBeNull()
  })

  it('refuses an icon too large to be one', async () => {
    routes['https://example.com/favicon.ico'] = { body: new Uint8Array(200_000).fill(7).map((v, i) => (i < 8 ? PNG[i]! : v)) }
    expect(await iconFor('example.com')).toBeNull()
  })

  it('takes an icon a page declares inline, once it checks out as an image', async () => {
    routes['https://example.com/'] = { body: `<link rel="icon" href="${dataUrl('image/png', PNG)}">` }
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
  })

  it('looks up several hosts at once, keyed by host', async () => {
    routes['https://a.example/favicon.ico'] = { body: PNG }
    expect(await iconsFor(['A.example', 'b.example', 'a.example'])).toEqual({
      'a.example': dataUrl('image/png', PNG),
      'b.example': null
    })
  })

  it('asks a site once while a lookup for it is already on its way', async () => {
    routes['https://example.com/favicon.ico'] = { body: PNG }
    const [a, b] = await Promise.all([iconFor('example.com'), iconFor('example.com')])
    expect(a).toBe(b)
    expect(requested).toEqual(['https://example.com/favicon.ico'])
  })

  it('touches nothing in a smoke or screenshot run', async () => {
    process.env['OPENCOURSE_SMOKE'] = '1'
    routes['https://example.com/favicon.ico'] = { body: PNG }
    expect(await iconFor('example.com')).toBeNull()
    expect(requested).toEqual([])
  })
})

describe('the cache', () => {
  it('answers from disk the second time', async () => {
    routes['https://example.com/favicon.ico'] = { body: PNG }
    await iconFor('example.com')
    requested = []
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
    expect(requested).toEqual([])
    expect(cacheFiles()).toHaveLength(1)
  })

  it('remembers a site with no icon for a day, then asks again', async () => {
    expect(await iconFor('example.com')).toBeNull()
    requested = []
    expect(await iconFor('example.com')).toBeNull()
    expect(requested).toEqual([])

    const file = join(userFaviconDir(listUsers()[0]!.id), cacheFiles()[0]!)
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { at: number }
    writeFileSync(file, JSON.stringify({ ...entry, at: entry.at - 25 * 60 * 60_000 }))
    routes['https://example.com/favicon.ico'] = { body: PNG }
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
  })

  it('does not remember an outage as a site with no icon', async () => {
    routes['https://example.com/favicon.ico'] = { error: true }
    routes['https://example.com/'] = { error: true }
    expect(await iconFor('example.com')).toBeNull()
    expect(cacheFiles()).toEqual([])
    routes['https://example.com/favicon.ico'] = { body: PNG }
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
  })

  it('hands back only an image, whatever the cache file was edited to say', async () => {
    routes['https://example.com/favicon.ico'] = { body: PNG }
    await iconFor('example.com')
    const file = join(userFaviconDir(listUsers()[0]!.id), cacheFiles()[0]!)
    writeFileSync(file, JSON.stringify({ host: 'example.com', at: Date.now(), type: 'text/html', data: 'PHNjcmlwdD4=' }))
    requested = []
    // Not vouched for, so it is looked up again rather than served.
    expect(await iconFor('example.com')).toBe(dataUrl('image/png', PNG))
    expect(requested).toEqual(['https://example.com/favicon.ico'])
  })

  it('keeps one person\'s cache to themselves', async () => {
    routes['https://example.com/favicon.ico'] = { body: PNG }
    await iconFor('example.com')
    const first = listUsers()[0]!.id
    createUser('Grace')
    requested = []
    await iconFor('example.com')
    expect(requested).toEqual(['https://example.com/favicon.ico'])
    expect(readdirSync(userFaviconDir(first))).toHaveLength(1)
  })
})
