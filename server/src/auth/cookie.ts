/**
 * The web app's session: the same opaque token the app holds, in a cookie
 * that script cannot read.
 *
 *  - HttpOnly, SameSite=Lax, Path=/. Over HTTPS also Secure and the `__Host-`
 *    prefix, which pins it to this exact host - no subdomain can set or shadow it.
 *  - A cookie rides along with requests the page did not mean to make, so a
 *    cookie-authenticated request that changes anything must come from this
 *    origin: `Sec-Fetch-Site: same-origin` (every current browser sends it),
 *    or, where it is missing, an `Origin` equal to the public URL's. Bearer
 *    requests - the app's - carry their credential explicitly and are exempt.
 *  - Nothing ever returns the token itself to the page.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ServerConfig } from '../config'
import { WEB_SESSION_TTL_MS } from './sessions'

export const cookieName = (config: ServerConfig): string => (isSecure(config) ? '__Host-ocs_session' : 'ocs_session')
const isSecure = (config: ServerConfig): boolean => config.publicUrl.startsWith('https://')

export function setSessionCookie(reply: FastifyReply, config: ServerConfig, token: string): void {
  reply.setCookie(cookieName(config), token, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: isSecure(config), maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000)
  })
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(cookieName(config), { httpOnly: true, sameSite: 'lax', path: '/', secure: isSecure(config) })
}

export function sessionCookie(request: FastifyRequest, config: ServerConfig): string | null {
  const value = request.cookies?.[cookieName(config)]
  return typeof value === 'string' && value ? value : null
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** True when a cookie-authenticated request may change something. */
export function sameOrigin(request: FastifyRequest, config: ServerConfig): boolean {
  if (SAFE_METHODS.has(request.method)) return true
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin'
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try { return new URL(origin).origin === new URL(config.publicUrl).origin } catch { return false }
}
