/**
 * Favicons for the pages a side chat answer cites.
 *
 * One of the few things in main that talk to the network (see openai.ts), and
 * the only one that talks to hosts nobody configured: the cited sites themselves.
 * The renderer cannot - `connect-src 'self'`, and `img-src` has no https: - so
 * main fetches, and an icon crosses as a `data:` URL, which `img-src` already
 * allows. Nothing about the policy had to change for this.
 *
 * Bounded every way it can be. Public hosts over https only, checked again at
 * every redirect (core/sidechat/favicon.ts); no cookies and no referrer; five
 * seconds and 100 KB per request; and only bytes that are an image by their
 * own magic numbers. Which hosts are asked about is decided in chat.ts from a
 * stored answer, never from a renderer's argument.
 *
 * Found icons are kept for thirty days and misses for one, on disk and per
 * user, so reopening a chat costs no requests. A host that could not be
 * reached at all is not remembered as a miss: offline for a minute should not
 * mean letter tiles for a day.
 */
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ICON_BYTES,
  MAX_PAGE_BYTES,
  fetchableUrl,
  iconLinks,
  isFetchableHost,
  sniffImage
} from '../core/sidechat/favicon'
import { userFaviconDir } from './paths'
import { requireUser } from './users'

export const FAVICON_TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 3
const FOUND_MS = 30 * 24 * 60 * 60_000
const MISSED_MS = 24 * 60 * 60_000
/** Icons declared by the page, tried in order after /favicon.ico. */
const MAX_CANDIDATES = 2
/** No answer cites more sites than this; a forged row asks about no more. */
const MAX_HOSTS = 50

const ICON_TYPES = /^image\/(?:x-icon|png|gif|jpeg|webp|svg\+xml)$/

interface Fetched {
  status: number
  body: Uint8Array
  /** Where the answer came from after redirects, for resolving relative links. */
  url: string
}

interface Icon {
  type: string
  data: string
}

/**
 * One GET. Redirects are followed by hand so each target is checked before it
 * is requested - a public page must not bounce the request into the local
 * network. Null for anything short of a whole answer; a page may be cut at
 * `maxBytes` (its head is what matters), an icon may not.
 */
function get(url: URL, maxBytes: number, accept: string, truncate: boolean): Promise<Fetched | null> {
  return new Promise((resolve) => {
    let current = url
    let hops = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (value: Fetched | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    let request: ReturnType<typeof net.request>
    try {
      request = net.request({
        url: url.toString(),
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })
    } catch {
      done(null)
      return
    }
    timer = setTimeout(() => {
      done(null)
      request.abort()
    }, FAVICON_TIMEOUT_MS)

    request.setHeader('Accept', accept)
    request.on('redirect', (_status, _method, redirectUrl) => {
      const next = fetchableUrl(redirectUrl)
      if (!next || ++hops > MAX_REDIRECTS) {
        done(null)
        request.abort()
        return
      }
      current = next
      request.followRedirect()
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      const finish = (): void =>
        done({ status: response.statusCode, body: new Uint8Array(Buffer.concat(chunks)), url: current.toString() })
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size <= maxBytes) {
          chunks.push(chunk)
          return
        }
        if (truncate) {
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
          finish()
        } else {
          done(null)
        }
        request.abort()
      })
      response.on('end', finish)
      response.on('error', () => done(null))
    })
    request.on('error', () => done(null))
    request.on('abort', () => done(null))
    request.end()
  })
}

function iconFrom(bytes: Uint8Array): Icon | null {
  if (!bytes.length || bytes.length > MAX_ICON_BYTES) return null
  const type = sniffImage(bytes)
  return type ? { type, data: Buffer.from(bytes).toString('base64') } : null
}

/** An icon a page declared inline - checked like a fetched one, never trusted for its label. */
function inlineIcon(dataUrl: string): Icon | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl)
  return match ? iconFrom(new Uint8Array(Buffer.from(match[1]!.replace(/\s/g, ''), 'base64'))) : null
}

/**
 * The site's icon: /favicon.ico first, because it is one small request that
 * usually works, then whatever the home page's `<link>` tags declare.
 * `reached` says whether any server answered at all.
 */
async function lookUp(host: string): Promise<{ icon: Icon | null; reached: boolean }> {
  const root = fetchableUrl(`https://${host}/`)
  if (!root) return { icon: null, reached: true }
  let reached = false
  const fetchIcon = async (url: URL): Promise<Icon | null> => {
    const got = await get(url, MAX_ICON_BYTES, 'image/*', false)
    if (got) reached = true
    return got && got.status === 200 ? iconFrom(got.body) : null
  }

  const direct = await fetchIcon(new URL('/favicon.ico', root))
  if (direct) return { icon: direct, reached }

  const page = await get(root, MAX_PAGE_BYTES, 'text/html', true)
  if (page) reached = true
  if (!page || page.status !== 200) return { icon: null, reached }
  const html = new TextDecoder().decode(page.body)
  for (const candidate of iconLinks(html, page.url).slice(0, MAX_CANDIDATES)) {
    const icon = candidate.startsWith('data:') ? inlineIcon(candidate) : await fetchIcon(new URL(candidate))
    if (icon) return { icon, reached }
  }
  return { icon: null, reached }
}

/* --- the cache ---------------------------------------------------------------- */

function cacheFile(user: string, host: string): string {
  return join(userFaviconDir(user), `${createHash('sha1').update(host).digest('hex')}.json`)
}

/** What the cache says: an icon, a remembered miss (null), or nothing it still vouches for. */
function readCached(file: string, now: number): { icon: string | null } | undefined {
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown; type?: unknown; data?: unknown }
    if (typeof entry.at !== 'number') return undefined
    const found = typeof entry.type === 'string' && typeof entry.data === 'string'
    if (now - entry.at >= (found ? FOUND_MS : MISSED_MS)) return undefined
    if (!found) return { icon: null }
    // The file is ours, but it is a file: what goes back is still only an image.
    if (!ICON_TYPES.test(entry.type as string) || !/^[A-Za-z0-9+/=]+$/.test(entry.data as string)) return undefined
    return { icon: `data:${entry.type as string};base64,${entry.data as string}` }
  } catch {
    return undefined
  }
}

/** Atomic, like every other writer here. A cache that cannot be written is only slower. */
function writeCached(file: string, entry: { host: string; at: number } & Partial<Icon>): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry))
    renameSync(tmp, file)
  } catch {
    // Nothing to do: the icon is still returned, it just is not remembered.
  }
}

/** Lookups in flight, so the five sources an answer cites from one site cost one. */
const pending = new Map<string, Promise<string | null>>()

/** One host's icon as a data URL, or null for a letter tile. */
export function iconFor(host: string): Promise<string | null> {
  const name = host.toLowerCase()
  if (!isFetchableHost(name)) return Promise.resolve(null)
  // A smoke or screenshot run never reaches the network; it shows letter tiles.
  if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) return Promise.resolve(null)

  const user = requireUser()
  const key = `${user}\0${name}`
  const inflight = pending.get(key)
  if (inflight) return inflight
  const file = cacheFile(user, name)
  const cached = readCached(file, Date.now())
  if (cached) return Promise.resolve(cached.icon)

  const job = (async (): Promise<string | null> => {
    const { icon, reached } = await lookUp(name).catch(() => ({ icon: null, reached: false }))
    if (icon) writeCached(file, { host: name, at: Date.now(), ...icon })
    else if (reached) writeCached(file, { host: name, at: Date.now() })
    return icon ? `data:${icon.type};base64,${icon.data}` : null
  })().finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}

/** Icons for several hosts at once, keyed by lower-cased host name. */
export async function iconsFor(hosts: readonly string[]): Promise<Record<string, string | null>> {
  const unique = [...new Set(hosts.map((host) => host.toLowerCase()))].slice(0, MAX_HOSTS)
  const icons = await Promise.all(unique.map((host) => iconFor(host)))
  return Object.fromEntries(unique.map((host, i) => [host, icons[i] ?? null]))
}
