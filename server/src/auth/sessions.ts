/**
 * Opaque session tokens. The app keeps one per server connection, encrypted
 * with the OS keychain, and sends it as a Bearer token; the web app's is the
 * same kind of token in an HttpOnly cookie (auth/cookie.ts). The server keeps
 * only its SHA-256, so a leaked database is not a list of working tokens. A
 * token slides to 90 days from its last use (a web one to 30), and a password
 * reset revokes every token the account has.
 *
 * Each session also has a random public id, so the settings page can list and
 * revoke sessions without the hash - or anything derived from the token -
 * ever leaving the server.
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../db'
import { TOKEN_PREFIX, type Account, type AccountRole, type SessionKind } from '@core/catalog/api'
import { sha256 } from './secrets'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60_000
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60_000
/** Bookkeeping writes are throttled: a busy client should not write on every request. */
const TOUCH_EVERY_MS = 60 * 60_000
const MAX_USER_AGENT = 200

const ttl = (kind: SessionKind): number => (kind === 'web' ? WEB_SESSION_TTL_MS : SESSION_TTL_MS)

export interface NewSession { kind?: SessionKind; userAgent?: string }

export function createSession(d: Db, accountId: string, options: NewSession = {}, now = Date.now()): string {
  const kind = options.kind ?? 'app'
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const at = new Date(now).toISOString()
  d.prepare('INSERT INTO sessions(token_hash, id, account_id, kind, user_agent, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), randomBytes(12).toString('hex'), accountId, kind, (options.userAgent ?? '').slice(0, MAX_USER_AGENT), at, at, new Date(now + ttl(kind)).toISOString())
  return token
}

export interface SessionViewer { account: Account; role: AccountRole; sessionId: string; kind: SessionKind }

export function sessionAccount(d: Db, token: string, now = Date.now()): SessionViewer | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null
  const hash = sha256(token)
  const row = d.prepare(`SELECT s.id AS session_id, s.kind, s.last_used_at, s.expires_at, a.id, a.username, a.email, a.role, a.disabled_at
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).get(hash) as
    { session_id: string; kind: SessionKind; last_used_at: string; expires_at: string; id: string; username: string; email: string; role: AccountRole; disabled_at: string | null } | undefined
  if (!row || row.disabled_at || Date.parse(row.expires_at) <= now) return null
  if (now - Date.parse(row.last_used_at) > TOUCH_EVERY_MS) {
    d.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), new Date(now + ttl(row.kind)).toISOString(), hash)
  }
  return { account: { id: row.id, username: row.username, email: row.email }, role: row.role, sessionId: row.session_id, kind: row.kind }
}

export function revokeSession(d: Db, token: string): void {
  d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function revokeAccountSessions(d: Db, accountId: string, except?: string): void {
  if (except) d.prepare('DELETE FROM sessions WHERE account_id = ? AND id != ?').run(accountId, except)
  else d.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId)
}
