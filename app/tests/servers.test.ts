// @vitest-environment node
/**
 * Connecting to OpenCourse servers, against a scripted server.
 *
 * The negative tests are the point: a token never in anything the renderer is
 * handed, never in plaintext on disk, never sent after a redirect, never left
 * for the next user; an address that would carry a password in the clear is
 * refused before anything is sent. The real server is exercised end to end by
 * the opt-in server-live test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeServerUrl } from '../src/core/catalog/url'
import { parseAuthResult, parseCatalogCourse, parseOverview } from '../src/core/catalog/parse'

const root = mkdtempSync(join(tmpdir(), 'opencourse-servers-'))
let dataDir = join(root, 'data')
let encryptionAvailable = true
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)), getAppPath: () => root, isPackaged: false, on: () => {} },
  net: { fetch: () => { throw new Error('the real network must not be used in tests') } },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer: Buffer) => [...buffer.toString().replace(/^enc:/, '')].reverse().join('')
  }
}))

const { createUser, requireUser, switchUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { setServerFetch } = await import('../src/main/serverclient')
const servers = await import('../src/main/servers')
const { readPreferences } = await import('../src/main/preferences')
const { userServersDir } = await import('../src/main/paths')

afterAll(() => { setServerFetch(null); rmSync(root, { recursive: true, force: true }) })

const TOKEN = 'ocs_' + 'T'.repeat(43)
const INFO = { opencourse: 1, api: 1, name: 'Test server', description: 'Courses.', registration: 'open' }
const ACCOUNT = { id: '6f0d3d0e-6c2a-4f4b-9a1e-0c6d1c1f2a3b', username: 'ada', email: 'ada@example.org' }
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: string | undefined }
let calls: Call[] = []
let routes: Record<string, (call: Call) => Response> = {}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  closeDb()
  dataDir = join(root, `data-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dataDir, { recursive: true })
  servers.forgetServerSessions()
  encryptionAvailable = true
  calls = []
  routes = {
    'GET /api/v1/server': () => json(INFO),
    'POST /api/v1/auth/register/start': () => json({ ok: true }, 202),
    'POST /api/v1/auth/register/verify': (call) => (call.body as { code: string }).code === '123456' ? json({ ticket: 'ticket-1' }) : json({ error: { code: 'invalid_code', message: 'That code is not right.', attemptsLeft: 3 } }, 400),
    'GET /api/v1/auth/username': () => json({ available: true }),
    'POST /api/v1/auth/register/complete': () => json({ token: TOKEN, account: ACCOUNT }, 201),
    'POST /api/v1/auth/login': (call) => (call.body as { password: string }).password === 'right password' ? json({ token: TOKEN, account: ACCOUNT }) : json({ error: { code: 'unauthorized', message: `That name or password is not right. ${TOKEN}` } }, 401),
    'POST /api/v1/auth/logout': () => new Response(null, { status: 204 })
  }
  setServerFetch(async (url, init) => {
    const parsed = new URL(url)
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null, redirect: init.redirect }
    calls.push(call)
    const handler = routes[`${call.method} ${parsed.pathname}`]
    return handler ? handler(call) : json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
  })
  switchUser(createUser('Learner').id)
})

async function signUp(url = 'https://courses.example.org') {
  const started = await servers.serverResult(() => servers.startRegistration(url, 'ada@example.org'))
  if (!started.ok) throw new Error(started.message)
  await servers.verifyRegistration(started.value.flowId, '123456')
  return servers.completeRegistration(started.value.flowId, 'ada', 'a long password')
}

describe('server addresses', () => {
  it('requires https except for this computer, and normalizes spellings to one', () => {
    expect(normalizeServerUrl('courses.example.org')).toMatchObject({ ok: true, url: 'https://courses.example.org' })
    expect(normalizeServerUrl('HTTPS://Courses.Example.org/opencourse/')).toMatchObject({ ok: true, url: 'https://courses.example.org/opencourse' })
    expect(normalizeServerUrl('localhost:8787')).toMatchObject({ ok: true, url: 'http://localhost:8787' })
    expect(normalizeServerUrl('http://127.0.0.1:8787')).toMatchObject({ ok: true })
    for (const bad of ['http://courses.example.org', 'ftp://x.org', 'https://user:pw@x.org', 'https://x.org/?a=1', 'https://x.org/#top', '']) expect(normalizeServerUrl(bad).ok).toBe(false)
  })
})

describe('reading what a server sends', () => {
  it('keeps only known fields, and refuses wrong shapes', () => {
    const course = { id: '6f0d3d0e-6c2a-4f4b-9a1e-0c6d1c1f2a3b', slug: 's', title: 'T', publisher: 'p', version: '1.0.0', updatedAt: 'now', tags: [], downloads: 1, lessonCount: 1, projectCount: 0, hasCover: false, script: '<script>' }
    expect(parseCatalogCourse(course)).not.toHaveProperty('script')
    expect(parseCatalogCourse({ ...course, version: '1.0' })).toBeNull()
    expect(parseCatalogCourse({ ...course, title: 'x'.repeat(10_000) })).toBeNull()
    expect(parseOverview(course)).toBeNull()
    expect(parseAuthResult({ token: 'sk-not-ours', account: ACCOUNT })).toBeNull()
  })
})

describe('connecting', () => {
  it('signs up by code, stores the token sealed, and never hands it to the renderer', async () => {
    const connection = await signUp()
    expect(connection).toMatchObject({ url: 'https://courses.example.org', name: 'Test server', account: { username: 'ada', email: 'ada@example.org' }, active: true })
    const everything = JSON.stringify([connection, servers.listConnections()])
    expect(everything).not.toContain('ocs_')
    const dir = userServersDir(requireUser())
    expect(readdirSync(dir).sort()).toEqual([`${connection.id}.token`, 'servers.json'])
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), 'utf8')).not.toContain(TOKEN)
    expect(readPreferences().activeServer).toBe(connection.id)
    // The completion call carried the ticket, not the code; the code went once.
    expect(calls.filter((c) => c.url.endsWith('/register/verify'))).toHaveLength(1)
    expect(calls.every((c) => c.redirect === 'error')).toBe(true)
  })

  it('reports a wrong code with what the server said, and keeps the flow going', async () => {
    const started = await servers.serverResult(() => servers.startRegistration('https://courses.example.org', 'ada@example.org'))
    if (!started.ok) throw new Error(started.message)
    const wrong = await servers.serverResult(() => servers.verifyRegistration(started.value.flowId, '000000'))
    expect(wrong).toEqual({ ok: false, code: 'invalid_code', message: 'That code is not right.', attemptsLeft: 3 })
    expect((await servers.serverResult(() => servers.verifyRegistration(started.value.flowId, '123456'))).ok).toBe(true)
  })

  it('refuses plain http to another machine before sending anything', async () => {
    const result = await servers.serverResult(() => servers.signIn('http://courses.example.org', 'ada', 'right password'))
    expect(result).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(calls).toEqual([])
  })

  it('scrubs a token a server echoes back in an error', async () => {
    const result = await servers.serverResult(() => servers.signIn('https://courses.example.org', 'ada', 'wrong'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('ocs_')
  })

  it('treats a redirect as a refusal, so a token is never carried elsewhere', async () => {
    await signUp()
    routes['GET /api/v1/server'] = () => { throw new TypeError('fetch failed: redirect mode is set to error') }
    const result = await servers.serverResult(() => servers.probeServer('https://courses.example.org'))
    expect(result).toMatchObject({ ok: false, code: 'unreachable' })
    routes['GET /api/v1/server'] = () => Object.defineProperty(json(INFO), 'redirected', { value: true })
    expect(await servers.serverResult(() => servers.probeServer('https://courses.example.org'))).toMatchObject({ ok: false, code: 'redirect' })
  })

  it('refuses a server that is not an OpenCourse server, or speaks a newer protocol', async () => {
    routes['GET /api/v1/server'] = () => json({ hello: 'world' })
    expect(await servers.serverResult(() => servers.probeServer('https://elsewhere.example.org'))).toMatchObject({ ok: false, code: 'bad_response' })
    routes['GET /api/v1/server'] = () => json({ ...INFO, api: 2 })
    expect(await servers.serverResult(() => servers.probeServer('https://elsewhere.example.org'))).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('signs out here even when the server cannot be reached, and forgets on remove', async () => {
    const connection = await signUp()
    routes['POST /api/v1/auth/logout'] = () => { throw new Error('offline') }
    const after = await servers.signOut(connection.id)
    expect(after[0]).toMatchObject({ id: connection.id, account: null })
    expect(servers.serverAccess(connection.id).token).toBe('')
    expect(await servers.removeConnection(connection.id)).toEqual([])
    expect(readPreferences().activeServer).toBeUndefined()
  })

  it('reconnecting to the same address replaces the account rather than adding a server', async () => {
    const first = await signUp('https://courses.example.org')
    const again = await servers.signIn('courses.example.org/', 'ada', 'right password')
    expect(again.id).toBe(first.id)
    expect(servers.listConnections()).toHaveLength(1)
  })

  it('keeps a token in memory only, when there is no keychain', async () => {
    encryptionAvailable = false
    const connection = await signUp()
    expect(existsSync(join(userServersDir(requireUser()), `${connection.id}.token`))).toBe(false)
    expect(servers.serverAccess(connection.id).token).toBe(TOKEN)
  })

  it('belongs to one user: another user sees no servers, and cannot finish their sign-up', async () => {
    const started = await servers.serverResult(() => servers.startRegistration('https://courses.example.org', 'ada@example.org'))
    await signUp()
    switchUser(createUser('Someone else').id)
    expect(servers.listConnections()).toEqual([])
    if (!started.ok) throw new Error(started.message)
    expect(await servers.serverResult(() => servers.verifyRegistration(started.value.flowId, '123456'))).toMatchObject({ ok: false, code: 'expired' })
  })
})
