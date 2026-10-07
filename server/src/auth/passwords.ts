/**
 * scrypt from node:crypto - memory-hard, built in, no native build. The
 * parameters live in the stored string, so raising them later only needs a
 * rehash on the next successful login, not a migration.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const N = 1 << 15, R = 8, P = 1, KEY = 64
const MAXMEM = 128 * N * R * 2

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password.normalize('NFC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Spent on a login for an account that does not exist, so timing says nothing either. */
const DUMMY = hashPassword('not a password anyone has')
export async function burnPasswordTime(password: string): Promise<void> {
  await verifyPassword(password, await DUMMY)
}
