/**
 * Six-digit email codes: for confirming an address at sign-up, for resetting a
 * password, and for confirming a signed-in account's new address. A code lives
 * ten minutes, allows five guesses, and is stored only as an HMAC. Asking for a
 * new code retires the old ones, so there is only ever one to guess at. A code
 * for a new address is also bound to the account that asked for it.
 */
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db'
import { CODE_LENGTH } from '@core/catalog/api'
import { hmac } from './secrets'

export type CodePurpose = 'register' | 'reset' | 'email'
export const CODE_TTL_MS = 10 * 60_000
export const MAX_CODE_ATTEMPTS = 5

const digest = (secret: Buffer, purpose: CodePurpose, email: string, code: string): string => hmac(secret, `${purpose}:${email.toLowerCase()}:${code}`)

export function issueCode(d: Db, secret: Buffer, purpose: CodePurpose, email: string, now = Date.now(), accountId: string | null = null): string {
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
  d.prepare('UPDATE email_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL').run(new Date(now).toISOString(), email, purpose)
  d.prepare('INSERT INTO email_codes(id, email, purpose, code_hmac, created_at, expires_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), email, purpose, digest(secret, purpose, email, code), new Date(now).toISOString(), new Date(now + CODE_TTL_MS).toISOString(), accountId)
  return code
}

export type CodeCheck = { ok: true } | { ok: false; attemptsLeft: number }

/** Consumes the code on success; counts a wrong guess against it otherwise. */
export function checkCode(d: Db, secret: Buffer, purpose: CodePurpose, email: string, code: string, now = Date.now(), accountId: string | null = null): CodeCheck {
  const row = d.prepare('SELECT id, code_hmac, expires_at, attempts, account_id FROM email_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(email, purpose) as { id: string; code_hmac: string; expires_at: string; attempts: number; account_id: string | null } | undefined
  if (!row || Date.parse(row.expires_at) <= now || row.attempts >= MAX_CODE_ATTEMPTS || row.account_id !== accountId) return { ok: false, attemptsLeft: 0 }
  const expected = Buffer.from(row.code_hmac, 'hex'), actual = Buffer.from(digest(secret, purpose, email, code), 'hex')
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    d.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id)
    return { ok: true }
  }
  d.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id)
  return { ok: false, attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - row.attempts - 1) }
}
