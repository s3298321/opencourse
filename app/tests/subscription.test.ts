// @vitest-environment node
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-subscription-'))
let dataDir = root
const mock = vi.hoisted(() => ({ fetch: vi.fn(), browser: vi.fn(), encryption: true, servers: [] as EventEmitter[] }))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir }, net: { fetch: mock.fetch }, shell: { openExternal: mock.browser },
  safeStorage: { isEncryptionAvailable: () => mock.encryption,
    encryptString: (text: string) => Buffer.from(`encrypted:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^encrypted:/, '') }
}))
vi.mock('node:http', () => ({ createServer: () => {
  const server = new EventEmitter()
  Object.assign(server, { listen: (_port: number, _host: string, callback: () => void) => queueMicrotask(callback),
    address: () => ({ port: 54321 }), close: vi.fn() })
  mock.servers.push(server)
  return server
} }))
const { createUser, switchUser } = await import('../src/main/users')
const { userDir } = await import('../src/main/paths')
const { cancelSubscriptionLogin, connectSubscription, disconnectSubscription, releaseSubscriptionSession, selectSubscriptionAccount,
  subscriptionAccessToken, subscriptionIdentity, subscriptionStatus } = await import('../src/main/subscription')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
let clientId = 'oaiapp_workspace_one', subject = 'learner-one', nonce = '', lifetime = 3600, serial = 0
let automaticCallback = true, invalidState = false, revocationFails = false
let userId = '', sequence = 0
function jwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'one' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: clientId, sub: subject,
    email: 'learner@example.com', exp: Math.floor(Date.now() / 1000) + 3600, nonce })).toString('base64url')
  const input = `${header}.${claims}`
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`
}
function tokens() { return { access_token: `subscription-access-${++serial}`, refresh_token: `subscription-refresh-${serial}`,
  id_token: jwt(), token_type: 'Bearer', expires_in: lifetime, scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct' } }
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) })
function callback(url: URL, override: Record<string, string> = {}): void {
  const params = new URLSearchParams({ state: invalidState ? 'invalid-state' : url.searchParams.get('state')!, code: 'code-one', client_id: clientId, ...override })
  const res = { writeHead: vi.fn(), end: vi.fn() }; res.writeHead.mockReturnValue(res)
  mock.servers.at(-1)!.emit('request', { method: 'GET', url: `/callback?${params}` }, res)
}
async function opened(): Promise<URL> {
  for (let n = 0; n < 100; n++) {
    if (mock.browser.mock.calls.length) return new URL(mock.browser.mock.calls.at(-1)![0])
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Sign-in did not open a browser')
}
beforeEach(() => {
  releaseSubscriptionSession()
  dataDir = join(root, `profile-${++sequence}`)
  userId = createUser('Learner').id
  mock.fetch.mockReset(); mock.browser.mockReset(); mock.servers.length = 0; mock.encryption = true
  clientId = 'oaiapp_workspace_one'; subject = 'learner-one'; lifetime = 3600; serial = 0
  automaticCallback = true; invalidState = false; revocationFails = false
  mock.browser.mockImplementation(async (value: string) => {
    const url = new URL(value); nonce = url.searchParams.get('nonce')!
    if (automaticCallback) queueMicrotask(() => callback(url))
  })
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('openid-configuration')) return response({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/keys', revocation_endpoint: 'https://auth.openai.com/revoke' })
    if (url.endsWith('/keys')) return response({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'one', alg: 'RS256' }] })
    if (url.endsWith('/token')) return response(tokens())
    if (url.endsWith('/revoke')) return response({}, revocationFails ? 500 : 200)
    throw new Error('Unexpected network request')
  })
})
afterAll(() => { releaseSubscriptionSession(); rmSync(root, { recursive: true, force: true }) })

describe('subscription session lifecycle', () => {
  it('uses dynamic registration, PKCE and a stable host, encrypts credentials, and exposes no tokens', async () => {
    await connectSubscription()
    const url = new URL(mock.browser.mock.calls[0][0])
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(url.searchParams.get('agent_name_hint')).toBe('OpenCourse')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const tokenCall = mock.fetch.mock.calls.find(([url]) => url.endsWith('/token'))!
    expect(new URLSearchParams(tokenCall[1].body).get('client_id')).toBe(clientId)
    const stored = readFileSync(join(userDir(userId), 'connections/chatgpt.json'), 'utf8')
    expect(stored).not.toContain('subscription-access')
    const status = subscriptionStatus()
    expect(status.accounts[0].connected).toBe(true)
    expect(JSON.stringify(status)).not.toContain('subscription-access')
    expect(await subscriptionAccessToken()).toBe('subscription-access-1')
    const host = url.searchParams.get('ext_agent_host_id')
    await connectSubscription(status.activeId!)
    const returning = new URL(mock.browser.mock.calls.at(-1)![0])
    expect(returning.searchParams.get('client_id')).toBe(clientId)
    expect(returning.searchParams.has('agent_name_hint')).toBe(false)
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(host)
  })
  it('rejects invalid state and returning account identity without replacing the active connection', async () => {
    invalidState = true
    await expect(connectSubscription()).rejects.toThrow('validation failed')
    expect(mock.fetch).not.toHaveBeenCalled()
    invalidState = false
    await connectSubscription()
    const active = subscriptionStatus().activeId!
    subject = 'another-learner'
    await expect(connectSubscription(active)).rejects.toThrow('did not match')
    expect(subscriptionStatus().activeId).toBe(active)
    expect(await subscriptionAccessToken()).toBe('subscription-access-1')
  })
  it('keeps different workspace registrations separate and supports selecting an existing one', async () => {
    await connectSubscription()
    const first = subscriptionStatus().activeId!
    clientId = 'oaiapp_workspace_two'
    await connectSubscription()
    expect(subscriptionStatus().accounts).toHaveLength(2)
    selectSubscriptionAccount(first)
    expect(await subscriptionAccessToken()).toBe('subscription-access-1')
  })
  it('serializes token refresh and saves the replacement refresh token', async () => {
    lifetime = 10
    await connectSubscription()
    expect(await Promise.all([subscriptionAccessToken(), subscriptionAccessToken()])).toEqual(['subscription-access-2', 'subscription-access-2'])
    const grants = mock.fetch.mock.calls.filter(([url]) => url.endsWith('/token'))
    expect(grants).toHaveLength(2)
    expect(new URLSearchParams(grants[1][1].body).get('refresh_token')).toBe('subscription-refresh-1')
    await subscriptionAccessToken()
    const last = mock.fetch.mock.calls.filter(([url]) => url.endsWith('/token')).at(-1)!
    expect(new URLSearchParams(last[1].body).get('refresh_token')).toBe('subscription-refresh-2')
  })
  it('marks expired authorization disconnected and never reuses the rejected refresh token', async () => {
    lifetime = 10; await connectSubscription()
    const original = mock.fetch.getMockImplementation()!
    mock.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/token') ? response({ error: 'invalid_grant' }, 401) : original(url, init))
    await expect(subscriptionAccessToken()).rejects.toThrow('Reconnect')
    expect(subscriptionIdentity()?.ready).toBe(false)
    const calls = mock.fetch.mock.calls.length
    await expect(subscriptionAccessToken()).rejects.toThrow('Connect')
    expect(mock.fetch).toHaveBeenCalledTimes(calls)
  })
  it('aborts outstanding refresh requests on local-user switching and rejects late results', async () => {
    lifetime = 10; await connectSubscription()
    const original = mock.fetch.getMockImplementation()!
    let finish!: (value: unknown) => void, signal!: AbortSignal
    mock.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (!url.endsWith('/token')) return original(url, init)
      signal = init.signal as AbortSignal
      return new Promise(resolve => { finish = resolve })
    })
    const refresh = subscriptionAccessToken()
    releaseSubscriptionSession(); createUser('Other')
    expect(signal.aborted).toBe(true)
    finish(response(tokens()))
    await expect(refresh).rejects.toThrow('connection changed')
    expect(subscriptionIdentity()).toBeNull()
  })
  it('cannot restore credentials after disconnect during an outstanding refresh', async () => {
    lifetime = 10; await connectSubscription()
    const original = mock.fetch.getMockImplementation()!
    let finish!: (value: unknown) => void
    mock.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/token')
      ? new Promise(resolve => { finish = resolve }) : original(url, init))
    const refresh = subscriptionAccessToken()
    await disconnectSubscription()
    finish(response(tokens()))
    await expect(refresh).rejects.toThrow('connection changed')
    expect(subscriptionStatus().accounts[0].connected).toBe(false)
    await expect(subscriptionAccessToken()).rejects.toThrow('Connect')
  })
  it('cancels pending sign-in on local-user switching and ignores late callbacks', async () => {
    automaticCallback = false
    const login = connectSubscription()
    const url = await opened()
    releaseSubscriptionSession()
    const other = createUser('Other')
    callback(url)
    await expect(login).rejects.toThrow('cancelled')
    expect(subscriptionStatus().accounts).toEqual([])
    switchUser(userId)
    expect(subscriptionStatus().accounts).toEqual([])
    switchUser(other.id)
  })
  it('supports explicit cancellation and memory-only credentials without cross-user access', async () => {
    automaticCallback = false
    const login = connectSubscription(); await opened(); cancelSubscriptionLogin()
    await expect(login).rejects.toThrow('cancelled')
    automaticCallback = true; mock.encryption = false
    await connectSubscription()
    expect(subscriptionStatus().volatile).toBe(true)
    expect(existsSync(join(userDir(userId), 'connections/chatgpt.json'))).toBe(false)
    releaseSubscriptionSession(); createUser('Other')
    expect(subscriptionIdentity()).toBeNull()
  })
  it('clears local tokens and reports unconfirmed remote revocation', async () => {
    await connectSubscription(); revocationFails = true
    expect((await disconnectSubscription()).warning).toContain('revocation')
    expect(subscriptionStatus().accounts[0].connected).toBe(false)
    expect(mock.fetch.mock.calls.filter(([url]) => url.endsWith('/revoke'))).toHaveLength(2)
  })
})
