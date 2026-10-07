/**
 * The OpenCourse servers a user has connected to, and signing in to them.
 *
 * A connection is an address, the server's name, and who this user is there.
 * It lives in users/<id>/servers/servers.json; the token that proves it is a
 * separate keychain-sealed file beside it (secrets.ts) and never leaves main.
 * One account per server per local user: connecting to the same address again
 * replaces the account rather than adding a second card.
 *
 * Sign-up is a conversation the app has with the server on the person's behalf
 * - email, code, username, password - so the state between steps (the address,
 * the email, the ticket the code buys) is kept here under a short-lived flow id
 * rather than in the renderer.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API_VERSION, emailProblem, isCode, passwordProblem, usernameProblem, type Account, type AuthResult, type ServerInfo } from '../core/catalog/api'
import { parseAccount, parseAuthResult, parseServerInfo } from '../core/catalog/parse'
import { normalizeServerUrl } from '../core/catalog/url'
import type { ServerConnection, ServerResult } from '../core/types'
import { userServersDir, serverTokenFile } from './paths'
import { readPreferences, writePreferences } from './preferences'
import { readSealed, removeSealed, writeSealed } from './secrets'
import { callServer, ServerError } from './serverclient'
import { currentUserId, requireUser } from './users'
import { log } from './log'

interface StoredConnection {
  id: string
  url: string
  name: string
  description: string
  account: Account | null
  connectedAt: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const serversFile = (userId: string): string => join(userServersDir(userId), 'servers.json')

/** Whatever can still be read: a hand-edited entry that makes no sense is dropped, not fatal. */
function readAll(userId = requireUser()): StoredConnection[] {
  const file = serversFile(userId)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { connections?: unknown[] }
    return (raw.connections ?? []).flatMap((entry) => {
      const c = entry as Partial<StoredConnection>
      const url = typeof c.url === 'string' ? normalizeServerUrl(c.url) : null
      if (typeof c.id !== 'string' || !UUID.test(c.id) || !url?.ok || typeof c.name !== 'string') return []
      return [{ id: c.id, url: url.url, name: c.name.slice(0, 120), description: typeof c.description === 'string' ? c.description.slice(0, 500) : '', account: parseAccount(c.account), connectedAt: String(c.connectedAt ?? '') }]
    })
  } catch {
    return []
  }
}

function writeAll(list: StoredConnection[], userId = requireUser()): void {
  const file = serversFile(userId)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, connections: list }, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/* --- tokens: main only ---------------------------------------------------- */

const volatileTokens = new Map<string, string>()

function readToken(userId: string, id: string): string {
  return volatileTokens.get(`${userId}/${id}`) ?? readSealed(serverTokenFile(userId, id))
}

function storeToken(userId: string, id: string, token: string): void {
  if (writeSealed(serverTokenFile(userId, id), token)) volatileTokens.delete(`${userId}/${id}`)
  else volatileTokens.set(`${userId}/${id}`, token)
}

function dropToken(userId: string, id: string): void {
  volatileTokens.delete(`${userId}/${id}`)
  removeSealed(serverTokenFile(userId, id))
}

/** Switching users must not leave another user's tokens or sign-ups in memory. */
export function forgetServerSessions(): void {
  volatileTokens.clear()
  flows.clear()
}

/* --- connections ---------------------------------------------------------- */

function view(c: StoredConnection, userId: string, active: string | undefined): ServerConnection {
  const signedIn = c.account !== null && readToken(userId, c.id) !== ''
  return { id: c.id, url: c.url, name: c.name, description: c.description, account: signedIn ? { username: c.account!.username, email: c.account!.email } : null, active: c.id === active }
}

export function listConnections(): ServerConnection[] {
  const userId = requireUser()
  const all = readAll(userId)
  const active = activeConnectionId(all)
  return all.map((c) => view(c, userId, active))
}

/** The active server, or the only one there is; a preference naming one that is gone means none. */
function activeConnectionId(all: StoredConnection[]): string | undefined {
  const preferred = readPreferences().activeServer
  if (preferred && all.some((c) => c.id === preferred)) return preferred
  return all.length === 1 ? all[0]!.id : undefined
}

export function setActiveServer(id: string | null): ServerConnection[] {
  const all = readAll()
  if (id !== null && !all.some((c) => c.id === id)) throw new Error('Unknown server.')
  const preferences = { ...readPreferences() }
  if (id === null) delete preferences.activeServer
  else preferences.activeServer = id
  writePreferences(preferences)
  return listConnections()
}

/** What main needs to talk to a server as this user. Never returned over IPC. */
export interface ServerAccess { id: string; url: string; name: string; token: string; account: Account | null }

export function serverAccess(id: string): ServerAccess {
  const userId = requireUser()
  const c = readAll(userId).find((entry) => entry.id === id)
  if (!c) throw new ServerError(404, 'unknown_server', 'That server is no longer connected. Add it again in Settings.')
  const token = c.account ? readToken(userId, c.id) : ''
  return { id: c.id, url: c.url, name: c.name, token, account: token ? c.account : null }
}

/** The connection for a course's origin address, if the user still has one. */
export function serverAccessForUrl(url: string): ServerAccess | null {
  const c = readAll().find((entry) => entry.url === url)
  return c ? serverAccess(c.id) : null
}

export function activeServerAccess(): ServerAccess | null {
  const all = readAll()
  const id = activeConnectionId(all)
  return id ? serverAccess(id) : null
}

function saveConnection(url: string, info: ServerInfo, auth: AuthResult): ServerConnection {
  const userId = requireUser()
  const all = readAll(userId)
  let entry = all.find((c) => c.url === url)
  if (!entry) {
    entry = { id: randomUUID(), url, name: info.name, description: info.description, account: null, connectedAt: new Date().toISOString() }
    all.push(entry)
  }
  Object.assign(entry, { name: info.name, description: info.description, account: auth.account })
  writeAll(all, userId)
  storeToken(userId, entry.id, auth.token)
  if (!readPreferences().activeServer || !all.some((c) => c.id === readPreferences().activeServer)) setActiveServer(entry.id)
  log.child('servers').info('Signed in to a server', { data: { host: new URL(url).host } })
  return listConnections().find((c) => c.id === entry!.id)!
}

/* --- results -------------------------------------------------------------- */

/** Turns a refusal into an answer the renderer can show; anything else is a real bug and is rethrown. */
export async function serverResult<T>(work: () => Promise<T>): Promise<ServerResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (error instanceof ServerError) {
      const attemptsLeft = typeof error.extra['attemptsLeft'] === 'number' ? error.extra['attemptsLeft'] : undefined
      const maxVersion = typeof error.extra['maxVersion'] === 'string' ? error.extra['maxVersion'] : undefined
      return { ok: false, code: error.code, message: error.message, ...(error.errors.length ? { errors: error.errors } : {}), ...(attemptsLeft !== undefined ? { attemptsLeft } : {}), ...(maxVersion ? { maxVersion } : {}) }
    }
    if (error instanceof UserFacingError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

class UserFacingError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/* --- signing in ----------------------------------------------------------- */

export async function probeServer(raw: string): Promise<{ url: string; info: ServerInfo }> {
  const normalized = normalizeServerUrl(String(raw ?? ''))
  if (!normalized.ok) throw new UserFacingError('invalid_url', normalized.message)
  const info = await callServer(normalized.url, '/server', parseServerInfo, { route: '/server' })
  if (info.api !== API_VERSION) throw new UserFacingError('unsupported', info.api > API_VERSION ? 'This server is newer than this version of OpenCourse. Update the app to connect.' : 'This server is too old for this version of OpenCourse.')
  return { url: normalized.url, info }
}

interface Flow { userId: string; url: string; info: ServerInfo; email: string; ticket?: string; expires: number }
const flows = new Map<string, Flow>()
const FLOW_TTL_MS = 30 * 60_000

function flow(id: string): Flow {
  const f = flows.get(String(id))
  if (!f || f.userId !== currentUserId() || f.expires < Date.now()) { flows.delete(String(id)); throw new UserFacingError('expired', 'This sign-up took too long. Start again.') }
  return f
}

function cleanEmail(raw: string): string {
  const email = String(raw ?? '').trim()
  const problem = emailProblem(email)
  if (problem) throw new UserFacingError('invalid_email', problem)
  return email
}

const accepted = (raw: unknown): object | null => (raw === null || typeof raw === 'object' ? {} : null)

/** Step one of sign-up: the server mails a code. */
export async function startRegistration(rawUrl: string, rawEmail: string): Promise<{ flowId: string; name: string }> {
  const email = cleanEmail(rawEmail)
  const { url, info } = await probeServer(rawUrl)
  if (info.registration === 'closed') throw new UserFacingError('registration_closed', `${info.name} is not accepting new accounts.`)
  await callServer(url, '/auth/register/start', accepted, { method: 'POST', json: { email }, route: '/auth/register/start' })
  const flowId = randomUUID()
  flows.set(flowId, { userId: requireUser(), url, info, email, expires: Date.now() + FLOW_TTL_MS })
  return { flowId, name: info.name }
}

export async function resendRegistrationCode(flowId: string): Promise<void> {
  const f = flow(flowId)
  await callServer(f.url, '/auth/register/start', accepted, { method: 'POST', json: { email: f.email }, route: '/auth/register/start' })
}

/** Step two: the code from the email confirms the address. */
export async function verifyRegistration(flowId: string, code: string): Promise<void> {
  const f = flow(flowId)
  const trimmed = String(code ?? '').trim()
  if (!isCode(trimmed)) throw new UserFacingError('invalid_code', 'Enter the 6-digit code from the email.')
  const result = await callServer(f.url, '/auth/register/verify', (raw) => {
    const ticket = (raw as { ticket?: unknown } | null)?.ticket
    return typeof ticket === 'string' && ticket.length <= 100 ? { ticket } : null
  }, { method: 'POST', json: { email: f.email, code: trimmed }, route: '/auth/register/verify' })
  f.ticket = result.ticket
}

export async function checkUsername(flowId: string, name: string): Promise<{ available: boolean; reason?: string }> {
  const f = flow(flowId)
  const problem = usernameProblem(String(name ?? ''))
  if (problem) return { available: false, reason: problem }
  return callServer(f.url, `/auth/username?name=${encodeURIComponent(name)}`, (raw) => {
    const o = raw as { available?: unknown; reason?: unknown } | null
    if (typeof o?.available !== 'boolean') return null
    return { available: o.available, ...(typeof o.reason === 'string' ? { reason: o.reason.slice(0, 200) } : {}) }
  }, { route: '/auth/username' })
}

/** Last step: a name and a password make the account, and the app is signed in. */
export async function completeRegistration(flowId: string, username: string, password: string): Promise<ServerConnection> {
  const f = flow(flowId)
  if (!f.ticket) throw new UserFacingError('invalid_ticket', 'Confirm your email address first.')
  const nameProblem = usernameProblem(String(username ?? ''))
  if (nameProblem) throw new UserFacingError('invalid_username', nameProblem)
  const pwProblem = passwordProblem(String(password ?? ''))
  if (pwProblem) throw new UserFacingError('weak_password', pwProblem)
  const auth = await callServer(f.url, '/auth/register/complete', parseAuthResult, { method: 'POST', json: { ticket: f.ticket, username, password }, route: '/auth/register/complete' })
  flows.delete(flowId)
  return saveConnection(f.url, f.info, auth)
}

export async function signIn(rawUrl: string, login: string, password: string): Promise<ServerConnection> {
  const { url, info } = await probeServer(rawUrl)
  const auth = await callServer(url, '/auth/login', parseAuthResult, { method: 'POST', json: { login: String(login ?? '').trim(), password: String(password ?? '') }, route: '/auth/login' })
  return saveConnection(url, info, auth)
}

export async function startPasswordReset(rawUrl: string, rawEmail: string): Promise<{ flowId: string; name: string }> {
  const email = cleanEmail(rawEmail)
  const { url, info } = await probeServer(rawUrl)
  await callServer(url, '/auth/password/forgot', accepted, { method: 'POST', json: { email }, route: '/auth/password/forgot' })
  const flowId = randomUUID()
  flows.set(flowId, { userId: requireUser(), url, info, email, expires: Date.now() + FLOW_TTL_MS })
  return { flowId, name: info.name }
}

export async function finishPasswordReset(flowId: string, code: string, password: string): Promise<ServerConnection> {
  const f = flow(flowId)
  const pwProblem = passwordProblem(String(password ?? ''))
  if (pwProblem) throw new UserFacingError('weak_password', pwProblem)
  const auth = await callServer(f.url, '/auth/password/reset', parseAuthResult, { method: 'POST', json: { email: f.email, code: String(code ?? '').trim(), password }, route: '/auth/password/reset' })
  flows.delete(flowId)
  return saveConnection(f.url, f.info, auth)
}

/** Signs out here and, as far as the server can still be reached, there too. */
export async function signOut(id: string): Promise<ServerConnection[]> {
  const userId = requireUser()
  const access = serverAccess(id)
  if (access.token) await callServer(access.url, '/auth/logout', accepted, { method: 'POST', token: access.token, route: '/auth/logout' }).catch(() => undefined)
  dropToken(userId, id)
  const all = readAll(userId)
  const entry = all.find((c) => c.id === id)
  if (entry) { entry.account = null; writeAll(all, userId) }
  return listConnections()
}

/** Forgets a server. Courses added from it stay, marked as from a server that is not connected. */
export async function removeConnection(id: string): Promise<ServerConnection[]> {
  await signOut(id)
  const userId = requireUser()
  writeAll(readAll(userId).filter((c) => c.id !== id), userId)
  if (readPreferences().activeServer === id) setActiveServer(null)
  return listConnections()
}
