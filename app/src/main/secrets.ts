/**
 * A secret on disk: encrypted with the OS keychain (safeStorage), or not
 * written at all. The OpenAI key (coachkey.ts) and every server token
 * (servers.ts) are stored this way, and neither ever crosses to the renderer.
 *
 * There is deliberately no plaintext fallback. When the platform has no
 * keychain, `writeSealed` says so and the caller keeps the value in memory for
 * this launch only - a file the user did not know was readable is worse than
 * signing in again.
 */
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface Envelope {
  version: number
  encrypted: true
  value: string
}

/** The stored value, or '' when there is none or it cannot be read here. */
export function readSealed(file: string): string {
  if (!existsSync(file)) return ''
  try {
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as Partial<Envelope>
    if (!envelope || typeof envelope.value !== 'string') return ''
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(envelope.value, 'base64'))
  } catch {
    // Written by another machine's keychain, or a truncated file. Asking
    // again is the only honest recovery.
    return ''
  }
}

/** Seals and writes atomically; false, and nothing written, when there is no keychain. */
export function writeSealed(file: string, value: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const envelope: Envelope = { version: 1, encrypted: true, value: safeStorage.encryptString(value).toString('base64') }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  return true
}

export function removeSealed(file: string): void {
  rmSync(file, { force: true })
}
