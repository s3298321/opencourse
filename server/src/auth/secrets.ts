/**
 * The server's own secret, made once and kept in the data directory. It keys
 * the HMAC over email codes, so a copy of the database alone cannot be used to
 * check guesses offline.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function serverSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'secret')
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  mkdirSync(dirname(file), { recursive: true })
  const secret = randomBytes(32)
  writeFileSync(file, secret.toString('base64'), { mode: 0o600, flag: 'wx' })
  return secret
}

export const hmac = (secret: Buffer, text: string): string => createHmac('sha256', secret).update(text).digest('hex')
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
