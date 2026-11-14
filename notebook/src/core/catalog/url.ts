/**
 * What a server address may be. A password crosses to it on sign-in and a
 * bearer token on every request after, so it is HTTPS - except plain HTTP to
 * this machine, for a server under development. No credentials in the URL, no
 * query, no fragment; an optional base path for a server behind a proxy.
 *
 * The normalized form is also a course's origin (CourseOrigin.server), so two
 * spellings of one address must come out identical.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export type ServerUrl = { ok: true; url: string; host: string } | { ok: false; message: string }

export function normalizeServerUrl(raw: string): ServerUrl {
  let text = raw.trim()
  if (!text) return { ok: false, message: 'Enter the server address.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0] ?? ''
    text = `${isLoopbackHost(host) ? 'http' : 'https'}://${text}`
  }
  let url: URL
  try { url = new URL(text) } catch { return { ok: false, message: 'That is not a web address.' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, message: 'Use an https:// address.' }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return { ok: false, message: 'Use https://. Plain http:// is allowed only for a server on this computer.' }
  if (url.username || url.password) return { ok: false, message: 'Leave your name and password out of the address.' }
  if (url.search || url.hash) return { ok: false, message: 'Use the server address without ? or #.' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${url.protocol}//${url.host.toLowerCase()}${path}`, host: url.host.toLowerCase() }
}
