/**
 * Opaque bearer tokens. The app keeps one per server connection, encrypted
 * with the OS keychain; the server keeps only its SHA-256, so a leaked
 * database is not a list of working tokens. A token slides to 90 days from its
 * last use, and a password reset revokes every token the account has.
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../db'
import { TOKEN_PREFIX, type Account } from '@core/catalog/api'
import { sha256 } from './secrets'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60_000
/** Bookkeeping writes are throttled: a busy client should not write on every request. */
const TOUCH_EVERY_MS = 60 * 60_000

export function createSession(d: Db, accountId: string, now = Date.now()): string {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const at = new Date(now).toISOString()
  d.prepare('INSERT INTO sessions(token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), accountId, at, at, new Date(now + SESSION_TTL_MS).toISOString())
  return token
}

export function sessionAccount(d: Db, token: string, now = Date.now()): Account | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null
  const hash = sha256(token)
  const row = d.prepare(`SELECT s.last_used_at, s.expires_at, a.id, a.username, a.email, a.disabled_at
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).get(hash) as
    { last_used_at: string; expires_at: string; id: string; username: string; email: string; disabled_at: string | null } | undefined
  if (!row || row.disabled_at || Date.parse(row.expires_at) <= now) return null
  if (now - Date.parse(row.last_used_at) > TOUCH_EVERY_MS) {
    d.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), hash)
  }
  return { id: row.id, username: row.username, email: row.email }
}

export function revokeSession(d: Db, token: string): void {
  d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function revokeAccountSessions(d: Db, accountId: string): void {
  d.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId)
}
