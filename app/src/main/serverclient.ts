/**
 * Every request the app makes to an OpenCourse server.
 *
 * Main makes them, never the renderer - `connect-src 'self'` stays as it is,
 * and the token a request carries is read here and nowhere else. Electron's
 * net.fetch follows the system's proxy settings, as openai.ts does.
 *
 * Four rules a server cannot talk its way past:
 *  - no redirects: a token is never carried to a host the user did not name;
 *  - every response is size-capped and parsed by core/catalog/parse.ts;
 *  - every error message is scrubbed, and logs carry metadata only - host,
 *    route, status, time - never an email, a code, a password or a token;
 *  - a download is streamed to a file under a byte cap.
 */
import { net } from 'electron'
import { createWriteStream, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { API_PREFIX } from '../core/catalog/api'
import { parseApiError } from '../core/catalog/parse'
import { scrubSecrets } from '../core/coach/key'
import { log } from './log'

const logger = log.child('servers')
const JSON_LIMIT = 5 * 1024 * 1024
const TIMEOUT_MS = 30_000

export class ServerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors: string[] = [], readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: Fetch = (url, init) => net.fetch(url, init)
/** Tests point the client at an in-process server with Node's own fetch. */
export function setServerFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((url, init) => net.fetch(url, init))
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  token?: string | null
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  timeoutMs?: number
  /** How the route is logged: the path with its ids taken out. */
  route: string
}

async function send(base: string, path: string, options: CallOptions): Promise<Response> {
  const started = Date.now()
  const host = new URL(base).host
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  let body = options.body
  if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json) }
  let response: Response
  try {
    response = await fetchImpl(`${base}${API_PREFIX}${path}`, {
      method: options.method ?? 'GET', headers, body, redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
    })
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError'
    logger.warn('Server unreachable', { data: { host, route: options.route, ms: Date.now() - started, timedOut } })
    throw new ServerError(0, timedOut ? 'timeout' : 'unreachable', timedOut ? 'The server did not answer in time.' : `Could not reach ${host}. Check the address and your connection.`)
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new ServerError(response.status, 'redirect', 'The server tried to send the app somewhere else. Use the address it redirects to, if you trust it.')
  }
  logger.info('Server request', { data: { host, route: options.route, status: response.status, ms: Date.now() - started } })
  return response
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) throw new ServerError(response.status, 'too_large', 'The server sent more than the app accepts.')
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new ServerError(response.status, 'too_large', 'The server sent more than the app accepts.') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function failure(response: Response): Promise<ServerError> {
  let raw: unknown = null
  try { raw = JSON.parse((await readCapped(response, 64 * 1024)).toString('utf8')) } catch { /* not JSON */ }
  const parsed = parseApiError(raw)
  if (parsed) {
    const extra = Object.fromEntries(Object.entries(parsed.extra).filter(([key]) => !['code', 'message', 'errors'].includes(key)))
    return new ServerError(response.status, parsed.code, scrubSecrets(parsed.message), (parsed.errors ?? []).map(scrubSecrets), extra)
  }
  return new ServerError(response.status, 'http_' + response.status, response.status === 404 ? 'That is not an OpenCourse server, or it does not have this.' : `The server answered ${response.status}.`)
}

/** A JSON call whose answer must pass `parse`; anything else is an error. */
export async function callServer<T>(base: string, path: string, parse: (raw: unknown) => T | null, options: CallOptions): Promise<T> {
  const response = await send(base, path, options)
  if (!response.ok) throw await failure(response)
  if (response.status === 204) {
    const empty = parse(null)
    if (empty === null) throw new ServerError(204, 'bad_response', 'The server sent an answer the app does not understand.')
    return empty
  }
  let raw: unknown
  try { raw = JSON.parse((await readCapped(response, JSON_LIMIT)).toString('utf8')) } catch { throw new ServerError(response.status, 'bad_response', 'The server sent an answer the app does not understand.') }
  const parsed = parse(raw)
  if (parsed === null) throw new ServerError(response.status, 'bad_response', 'The server sent an answer the app does not understand.')
  return parsed
}

/** Bytes, for a cover image. */
export async function fetchBytes(base: string, path: string, limit: number, options: CallOptions): Promise<{ bytes: Buffer; type: string | null }> {
  const response = await send(base, path, options)
  if (!response.ok) throw await failure(response)
  return { bytes: await readCapped(response, limit), type: response.headers.get('content-type') }
}

/** Streams a course archive to `file` under a byte cap, checked against the digest the server sent. */
export async function downloadArchive(base: string, path: string, file: string, limit: number, options: CallOptions): Promise<{ version: string | null }> {
  const response = await send(base, path, { ...options, timeoutMs: options.timeoutMs ?? 10 * 60_000 })
  if (!response.ok) throw await failure(response)
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new ServerError(response.status, 'too_large', 'The course is larger than the app accepts.')
  const reader = response.body?.getReader()
  if (!reader) throw new ServerError(response.status, 'bad_response', 'The server sent an empty course.')
  const hash = createHash('sha256'), out = createWriteStream(file)
  const write = (chunk: Uint8Array): Promise<void> => new Promise((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())))
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new ServerError(response.status, 'too_large', 'The course is larger than the app accepts.') }
      hash.update(value)
      await write(value)
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
  const expected = response.headers.get('x-opencourse-sha256')
  if (expected && hash.digest('hex') !== expected.toLowerCase()) throw new ServerError(response.status, 'corrupt_download', 'The download was damaged on the way. Try again.')
  return { version: response.headers.get('x-opencourse-version') }
}

/** Uploads a course archive from disk. */
export async function uploadArchive<T>(base: string, path: string, file: string, parse: (raw: unknown) => T | null, options: CallOptions): Promise<T> {
  return callServer(base, path, parse, { ...options, method: 'POST', body: readFileSync(file), headers: { ...options.headers, 'content-type': 'application/zip' }, timeoutMs: options.timeoutMs ?? 10 * 60_000 })
}
