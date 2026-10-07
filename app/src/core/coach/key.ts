/**
 * What an OpenAI key looks like, and how to keep one out of everything else.
 *
 * Pure: main/coachkey.ts owns the safeStorage envelope and the file. The rule
 * this file exists to enforce is that a key is never the thing that leaks - not
 * through an error message, not through a stack trace, not through a status
 * union on its way to the renderer.
 */

/** Covers sk-, sk-proj-, sk-svcacct- and anything else of that shape. */
const KEY_RE = /^sk-[A-Za-z0-9_-]{20,250}$/

/** Ephemeral realtime client secrets and OpenCourse server tokens. Short-lived or not, credentials. */
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|ek_[A-Za-z0-9_-]{8,}|ocs_[A-Za-z0-9_-]{8,})/g
const secrets = new Set<string>()
export function registerSecrets(...values: (string | undefined)[]): void {
  for (const value of values) if (value && value.length >= 8) secrets.add(value)
}

export function normalizeKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

export function isPlausibleKey(raw: unknown): boolean {
  return KEY_RE.test(normalizeKey(raw))
}

/**
 * Removes anything key-shaped from text on its way out of main.
 *
 * OpenAI's own error bodies quote the key they rejected, and an unhandled fetch
 * error can carry a request header. Everything that becomes an Error the
 * renderer sees goes through here first.
 */
export function scrubSecrets(text: string): string {
  let clean = text.replace(SECRET_RE, '[redacted]')
    .replace(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?[^\s<>"']+/g, '[redacted authorization URL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/([?&](?:id_token_hint|access_token|refresh_token|code)=)[^&\s]+/g, '$1[redacted]')
  for (const secret of secrets) clean = clean.split(secret).join('[redacted]')
  return clean
}

/** The last four characters, for a UI that has to say *which* key is stored. */
export function keyHint(key: string): string {
  const trimmed = normalizeKey(key)
  return trimmed.length >= 4 ? `…${trimmed.slice(-4)}` : '…'
}
