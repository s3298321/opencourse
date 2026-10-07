/**
 * The user's OpenAI key. The first secret this app has ever stored.
 *
 * Three rules, in order of how much they would cost to get wrong:
 *
 * 1. It never crosses to the renderer. The bridge exposes `hasOpenAIKey(): boolean`,
 *    `setOpenAIKey` and `clearOpenAIKey`, and nothing else. No IPC handler
 *    returns it, embeds it, or puts it in an object that gets returned.
 * 2. It is never written in plaintext. If the platform has no keychain,
 *    `setKey` reports `unavailable` and holds the key in memory for this launch
 *    only - a file the user did not know was readable is worse than asking again.
 * 3. It is per user, under users/<id>/coach/, so `deleteUser`'s one rmSync takes
 *    it along with everything else that user owned.
 */
import { safeStorage } from 'electron'
import { isPlausibleKey, keyHint, normalizeKey } from '../core/coach/key'
import type { CoachKeyResult } from '../core/types'
import { coachKeyFile } from './paths'
import { requireUser } from './users'
import { currentUserId } from './users'
import { readSealed, removeSealed, writeSealed } from './secrets'
const keyGenerations = new Map<string, number>()

/**
 * Where a key lives when there is no keychain to put it in. Keyed by user so
 * switching users cannot hand one person's key to another, and never written.
 */
const volatile = new Map<string, string>()

/** Reads the stored key, or '' when there is none. Main-process use only. */
export function readKey(): string {
  const userId = requireUser()
  const inMemory = volatile.get(userId)
  if (inMemory) return inMemory

  return readSealed(coachKeyFile(userId))
}

export function hasKey(): boolean {
  return readKey() !== ''
}

/** For a UI that has to say which key is stored without showing it. */
export function storedKeyHint(): string | null {
  const key = readKey()
  return key ? keyHint(key) : null
}

/**
 * Persists a key that has already been checked against the API.
 *
 * `validate` is injected rather than imported so this module stays testable
 * without a network, and so openai.ts can own the one place that talks to
 * OpenAI.
 */
export async function setKey(
  raw: unknown,
  validate: (key: string) => Promise<{ ok: true } | { ok: false; message: string }>
): Promise<CoachKeyResult> {
  const key = normalizeKey(raw)
  if (!isPlausibleKey(key)) {
    return { status: 'invalid', message: 'that does not look like an OpenAI key - they start with "sk-"' }
  }

  const userId = requireUser()
  const epoch = (keyGenerations.get(userId) ?? 0) + 1
  keyGenerations.set(userId, epoch)
  const verdict = await validate(key)
  if (!verdict.ok) return { status: 'invalid', message: verdict.message }
  if (currentUserId() !== userId || keyGenerations.get(userId) !== epoch) return { status: 'invalid', message: 'The user or connection changed. Save the key again.' }
  if (!safeStorage.isEncryptionAvailable()) {
    // Deliberately no plaintext fallback.
    volatile.set(userId, key)
    return { status: 'unavailable' }
  }

  writeSealed(coachKeyFile(userId), key)
  volatile.delete(userId)
  return { status: 'ok' }
}

export function clearKey(): void {
  const userId = requireUser()
  keyGenerations.set(userId, (keyGenerations.get(userId) ?? 0) + 1)
  volatile.delete(userId)
  removeSealed(coachKeyFile(userId))
}

/** Switching users must not leave the previous one's key in memory. */
export function forgetVolatileKeys(): void {
  for (const [id, epoch] of keyGenerations) keyGenerations.set(id, epoch + 1)
  volatile.clear()
}
