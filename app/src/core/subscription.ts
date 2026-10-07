import { constants, createPublicKey, verify, type JsonWebKey } from 'node:crypto'

export const AUTH_ORIGIN = 'https://auth.openai.com'
export const SUBSCRIPTION_RESOURCE = 'https://api.openai.com/v1'
export const SUBSCRIPTION_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

export function authEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('OpenAI did not provide an authentication endpoint.')
  const url = new URL(value)
  if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash) throw new Error('Invalid OpenAI authentication endpoint.')
  return url.href
}

/** Verify before using any ID-token identity or account information. */
export function validateIdToken(token: string, jwks: unknown, clientId: string, nonce?: string, now = Date.now()): { subject: string; email?: string } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid OpenAI identity token.')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string; crit?: unknown }
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
  if (header.crit || !['RS256', 'PS256', 'ES256'].includes(header.alg ?? '')) throw new Error('Unsupported OpenAI identity signature.')
  const keys = (jwks as { keys?: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] })?.keys
  const jwk = keys?.find(k => k.kid === header.kid && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig'))
  if (!jwk || (header.alg === 'ES256' ? jwk.kty !== 'EC' || jwk.crv !== 'P-256' : jwk.kty !== 'RSA')) throw new Error('OpenAI identity signing key was not found.')
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const valid = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), {
    key,
    ...(header.alg === 'PS256' ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : {}),
    ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {})
  }, Buffer.from(parts[2], 'base64url'))
  const audience = Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId
  if (!valid || claims.iss !== AUTH_ORIGIN || !audience || typeof claims.sub !== 'string' || !claims.sub ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    typeof claims.exp !== 'number' || claims.exp * 1000 <= now ||
    (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + 60000) ||
    (nonce !== undefined && claims.nonce !== nonce)) throw new Error('OpenAI identity validation failed.')
  return { subject: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) }
}
