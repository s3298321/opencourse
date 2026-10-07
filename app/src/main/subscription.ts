import { app, net, safeStorage, shell } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AUTH_ORIGIN, authEndpoint, SUBSCRIPTION_RESOURCE, SUBSCRIPTION_SCOPES, validateIdToken } from '../core/subscription'
import { registerSecrets, scrubSecrets } from '../core/coach/key'
import type { SubscriptionStatus } from '../core/types'
import { userDir } from './paths'
import { currentUserId, requireUser } from './users'
import { log } from './log'

const subscriptionLog = log.child('subscription')

interface Registration {
  id: string; clientId: string; subject: string; email?: string; label: string
  accessToken?: string; refreshToken?: string; idToken?: string; expiresAt?: number; earliestRefreshAt?: number
}
interface Credentials { accounts: Registration[]; activeId: string | null }
interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint: string }
interface TokenResponse { access_token: string; refresh_token: string; id_token?: string; expires_in: number; scope: string; token_type: string; earliest_refresh_at?: number }
const volatile = new Map<string, Credentials>()
const generations = new Map<string, number>()
const refreshes = new Map<string, Promise<string>>()
const refreshControllers = new Map<string, AbortController>()
class AuthorizationRejected extends Error {}
export const subscriptionEvents = new EventEmitter()
let pending: { owner: string; controller: AbortController; server: Server } | null = null
const generation = (owner: string): number => generations.get(owner) ?? 0
const file = (owner: string): string => join(userDir(owner), 'connections', 'chatgpt.json')

function read(owner: string): Credentials {
  if (volatile.has(owner)) return structuredClone(volatile.get(owner)!)
  try {
    const envelope = JSON.parse(readFileSync(file(owner), 'utf8')) as { encrypted: string }
    if (!safeStorage.isEncryptionAvailable()) return { accounts: [], activeId: null }
    const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64'))) as Credentials
    if (!Array.isArray(data.accounts)) throw new Error('Invalid credentials')
    for (const a of data.accounts) registerSecrets(a.accessToken, a.refreshToken, a.idToken)
    return data
  } catch { return { accounts: [], activeId: null } }
}
function write(owner: string, credentials: Credentials): void {
  if (!safeStorage.isEncryptionAvailable()) { volatile.set(owner, structuredClone(credentials)); return }
  const target = file(owner)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, encrypted: safeStorage.encryptString(JSON.stringify(credentials)).toString('base64') }), { mode: 0o600 })
  renameSync(temporary, target)
  volatile.delete(owner)
}
function hostId(): string {
  const target = join(app.getPath('userData'), 'ai-host.json')
  if (existsSync(target)) {
    const saved = JSON.parse(readFileSync(target, 'utf8')) as { id?: string }
    if (typeof saved.id === 'string' && /^urn:uuid:[0-9a-f-]{36}$/.test(saved.id)) return saved.id
  }
  const id = `urn:uuid:${randomUUID()}`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({ id }), { mode: 0o600 })
  return id
}
async function jsonRequest(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await net.fetch(authEndpoint(url), { ...init, signal: init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
  if (!response.ok) {
    // Never relay token endpoint bodies: they may contain arbitrary credentials.
    if (response.status === 400 || response.status === 401) throw new AuthorizationRejected('ChatGPT authorization expired or was rejected. Reconnect in Settings.')
    throw new Error(`ChatGPT authentication could not complete (${response.status}). Try again.`)
  }
  return JSON.parse(await response.text())
}
async function discovery(signal?: AbortSignal): Promise<Discovery> {
  const result = await jsonRequest(`${AUTH_ORIGIN}/.well-known/openid-configuration`, { signal }) as Discovery
  if (result.issuer !== AUTH_ORIGIN) throw new Error('Invalid OpenAI identity issuer.')
  authEndpoint(result.jwks_uri); authEndpoint(result.revocation_endpoint)
  return result
}
async function exchange(params: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const token = await jsonRequest(`${AUTH_ORIGIN}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, resource: SUBSCRIPTION_RESOURCE }).toString(), signal
  }) as TokenResponse
  if (!token || typeof token.access_token !== 'string' || !token.access_token ||
    typeof token.refresh_token !== 'string' || !token.refresh_token || token.token_type?.toLowerCase() !== 'bearer' ||
    typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
    typeof token.scope !== 'string' || !token.scope.split(' ').includes('chatgpt.tokens.use.direct') ||
    !token.scope.split(' ').includes('resource.invoke')) throw new Error('ChatGPT plan usage was not authorized. Reconnect and allow plan usage.')
  return token
}
function withTokens(account: Registration, token: TokenResponse): Registration {
  registerSecrets(token.access_token, token.refresh_token, token.id_token)
  return { ...account, accessToken: token.access_token, refreshToken: token.refresh_token,
    idToken: token.id_token ?? account.idToken, expiresAt: Date.now() + token.expires_in * 1000,
    earliestRefreshAt: typeof token.earliest_refresh_at === 'number' ? token.earliest_refresh_at * 1000 : undefined }
}
export function subscriptionStatus(): SubscriptionStatus {
  const owner = requireUser(), data = read(owner)
  return { accounts: data.accounts.map(a => ({ id: a.id, label: a.label, connected: Boolean(a.refreshToken) })),
    activeId: data.activeId, pending: pending?.owner === owner, volatile: volatile.has(owner) }
}
export function subscriptionIdentity(): { id: string; label: string; ready: boolean; volatile: boolean } | null {
  const owner = requireUser(), data = read(owner), account = data.accounts.find(a => a.id === data.activeId)
  return account ? { id: account.id, label: account.label, ready: Boolean(account.refreshToken), volatile: volatile.has(owner) } : null
}
export function cancelSubscriptionLogin(): void {
  if (pending) { pending.controller.abort(); pending.server.close(); pending = null; subscriptionEvents.emit('changed') }
}
function abortRefreshes(owner: string): void {
  for (const [key, controller] of refreshControllers) if (key.startsWith(`${owner}:`)) controller.abort()
}
/** Called before the local-user session changes, including deletion. */
export function releaseSubscriptionSession(): void {
  cancelSubscriptionLogin()
  const owner = currentUserId()
  if (owner) { generations.set(owner, generation(owner) + 1); abortRefreshes(owner) }
}
export function forgetSubscriptionUser(owner: string): void {
  if (pending?.owner === owner) cancelSubscriptionLogin()
  generations.set(owner, generation(owner) + 1)
  abortRefreshes(owner)
  volatile.delete(owner)
}
export async function connectSubscription(accountId?: string): Promise<SubscriptionStatus> {
  cancelSubscriptionLogin()
  const owner = requireUser(), epoch = generation(owner), data = read(owner)
  const returning = accountId ? data.accounts.find(a => a.id === accountId) : undefined
  if (accountId && !returning) throw new Error('Choose a saved ChatGPT account.')
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url'), controller = new AbortController()
  const server = createServer()
  const attempt = { owner, controller, server }
  pending = attempt
  const timeout = setTimeout(() => controller.abort(), 5 * 60000)
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    if (controller.signal.aborted || pending !== attempt) throw new Error('ChatGPT sign-in cancelled.')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the ChatGPT sign-in callback.')
    const redirect = `http://127.0.0.1:${address.port}/callback`
    const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('ChatGPT sign-in cancelled.')), { once: true })
      server.on('request', (request, response) => {
        let url: URL
        try { url = new URL(request.url ?? '/', redirect) }
        catch { response.writeHead(400).end('Invalid callback.'); return }
        if (request.method !== 'GET' || url.pathname !== '/callback') { response.writeHead(404).end(); return }
        const fail = (message: string): void => { response.writeHead(400, { 'Content-Type': 'text/plain' }).end(message); reject(new Error(message)) }
        if (url.searchParams.get('state') !== state) { fail('ChatGPT sign-in validation failed.'); return }
        if (url.searchParams.has('error')) { fail('ChatGPT sign-in was declined.'); return }
        const clientId = url.searchParams.get('client_id') ?? returning?.clientId
        const code = url.searchParams.get('code')
        if (!clientId || clientId === 'dynamic_agent_client' || clientId.length > 200 || !code ||
          (returning && clientId !== returning.clientId)) { fail('ChatGPT registration was incomplete or did not match.'); return }
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Sign-in received. You can return to opencourse.')
        resolve({ code, clientId })
      })
    })
    // Register rejection handling before opening the browser.
    void callback.catch(() => undefined)
    const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`)
    const params: Record<string, string> = { client_id: returning?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId(), response_type: 'code', redirect_uri: redirect,
      scope: SUBSCRIPTION_SCOPES, resource: SUBSCRIPTION_RESOURCE, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }
    if (!returning) params.agent_name_hint = 'OpenCourse'
    if (returning?.idToken) params.id_token_hint = returning.idToken
    if (returning?.email) params.login_hint = returning.email
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    subscriptionEvents.emit('changed')
    await shell.openExternal(url.href)
    const result = await callback
    server.close()
    const token = await exchange({ grant_type: 'authorization_code', client_id: result.clientId,
      code: result.code, code_verifier: verifier, redirect_uri: redirect }, controller.signal)
    if (!token.id_token) throw new Error('OpenAI did not return an identity token.')
    const metadata = await discovery(controller.signal)
    const identity = validateIdToken(token.id_token, await jsonRequest(metadata.jwks_uri, { signal: controller.signal }), result.clientId, nonce)
    if (returning && identity.subject !== returning.subject) throw new Error('The selected ChatGPT account did not match.')
    if (currentUserId() !== owner || generation(owner) !== epoch || pending !== attempt || controller.signal.aborted) throw new Error('ChatGPT sign-in cancelled.')
    const id = createHash('sha256').update(`${result.clientId}:${identity.subject}`).digest('hex')
    const current = read(owner)
    const registration = withTokens({ id, clientId: result.clientId, subject: identity.subject, email: identity.email,
      label: `${identity.email ?? 'ChatGPT account'} · ${result.clientId.slice(-6)}` }, token)
    subscriptionEvents.emit('stop', owner)
    generations.set(owner, epoch + 1)
    abortRefreshes(owner)
    write(owner, { accounts: [...current.accounts.filter(a => a.id !== id), registration], activeId: id })
    subscriptionLog.info('ChatGPT account connected', { returning: Boolean(returning) })
  } catch (error) {
    const message = scrubSecrets((error as Error).message)
    if (/cancelled/i.test(message)) subscriptionLog.info('ChatGPT sign-in cancelled')
    else subscriptionLog.error('ChatGPT sign-in failed', { message })
    throw new Error(message)
  }
  finally {
    clearTimeout(timeout); server.close()
    if (pending === attempt) pending = null
    subscriptionEvents.emit('changed')
  }
  return subscriptionStatus()
}
export function selectSubscriptionAccount(id: string): SubscriptionStatus {
  cancelSubscriptionLogin()
  const owner = requireUser(), data = read(owner)
  if (!data.accounts.some(a => a.id === id)) throw new Error('Unknown ChatGPT account.')
  subscriptionEvents.emit('stop', owner)
  generations.set(owner, generation(owner) + 1)
  abortRefreshes(owner)
  write(owner, { ...data, activeId: id }); subscriptionEvents.emit('changed')
  return subscriptionStatus()
}
export async function disconnectSubscription(): Promise<{ warning?: string }> {
  cancelSubscriptionLogin()
  const owner = requireUser(), data = read(owner), account = data.accounts.find(a => a.id === data.activeId)
  subscriptionEvents.emit('stop', owner)
  generations.set(owner, generation(owner) + 1)
  abortRefreshes(owner)
  if (!account) return {}
  // Clear locally first so pending refreshes cannot restore the session.
  const { accessToken: _access, refreshToken: _refresh, idToken: _identity, ...retained } = account
  write(owner, { ...data, accounts: data.accounts.map(a => a.id === account.id ? retained : a) })
  subscriptionEvents.emit('changed')
  if (!account.refreshToken) return {}
  try {
    const metadata = await discovery()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await net.fetch(authEndpoint(metadata.revocation_endpoint), { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString() })
      if (response.ok) return {}
      if (response.status < 500) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } catch (error) { subscriptionLog.warn('Revoking the ChatGPT session failed; signed out locally', { error }) }
  return { warning: 'Disconnected locally. Remote revocation could not be confirmed; disconnect OpenCourse in ChatGPT Settings.' }
}
export async function subscriptionAccessToken(expectedId?: string): Promise<string> {
  const owner = requireUser(), epoch = generation(owner), data = read(owner)
  const account = data.accounts.find(a => a.id === data.activeId)
  if (!account?.refreshToken || (expectedId && account.id !== expectedId)) throw new Error('Connect your ChatGPT subscription in Settings.')
  if (account.accessToken && ((account.expiresAt ?? 0) > Date.now() + 60000 ||
    ((account.earliestRefreshAt ?? 0) > Date.now() && (account.expiresAt ?? 0) > Date.now()))) return account.accessToken
  const key = `${owner}:${account.id}:${epoch}`
  const existing = refreshes.get(key)
  if (existing) return existing
  const controller = new AbortController()
  refreshControllers.set(key, controller)
  const operation = (async (): Promise<string> => {
    const token = await exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken! }, controller.signal)
    if (token.id_token) {
      const metadata = await discovery(controller.signal)
      const identity = validateIdToken(token.id_token, await jsonRequest(metadata.jwks_uri, { signal: controller.signal }), account.clientId)
      if (identity.subject !== account.subject) throw new Error('ChatGPT account identity changed. Reconnect in Settings.')
    }
    const current = read(owner)
    if (currentUserId() !== owner || generation(owner) !== epoch || current.activeId !== account.id) throw new Error('ChatGPT connection changed.')
    write(owner, { ...current, accounts: current.accounts.map(a => a.id === account.id ? withTokens(a, token) : a) })
    return token.access_token
  })()
  refreshes.set(key, operation)
  try { return await operation }
  catch (error) {
    subscriptionLog.warn('Refreshing the ChatGPT session failed', { rejected: error instanceof AuthorizationRejected, message: scrubSecrets((error as Error).message) })
    if (error instanceof AuthorizationRejected && currentUserId() === owner && generation(owner) === epoch) {
      const current = read(owner)
      const { accessToken: _access, refreshToken: _refresh, idToken: _identity, ...retained } = account
      generations.set(owner, epoch + 1)
      write(owner, { ...current, accounts: current.accounts.map(a => a.id === account.id ? retained : a) })
      subscriptionEvents.emit('stop', owner); subscriptionEvents.emit('changed')
    }
    throw new Error(scrubSecrets((error as Error).message))
  } finally { if (refreshes.get(key) === operation) refreshes.delete(key); refreshControllers.delete(key) }
}

/** Synthetic credentials are confined to the disposable Electron smoke profile. */
export function simulateSubscriptionForSmoke(): void {
  if (!process.env['OPENCOURSE_SMOKE'] || app.getPath('userData') !== process.env['OPENCOURSE_RUN_PROFILE']) throw new Error('Subscription simulation is unavailable.')
  const owner = requireUser()
  volatile.set(owner, { accounts: [{ id: 'smoke-subscription', clientId: 'smoke-client', subject: 'smoke', label: 'Simulated account / workspace',
    accessToken: 'opencourse-smoke-subscription', refreshToken: 'opencourse-smoke-refresh', expiresAt: Date.now() + 3600000 }], activeId: 'smoke-subscription' })
  subscriptionEvents.emit('changed')
}
