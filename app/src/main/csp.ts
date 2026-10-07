/**
 * The renderer's Content-Security-Policy.
 *
 * Its own module, with no Electron import, for two reasons: smoke asserts the
 * exact policy and must not pull main's bootstrap in to get it, and `cspFor` is
 * then a pure function a unit test can pin.
 */

/**
 * `connect-src 'self'` is the load-bearing clause: the renderer makes no
 * network requests at all. The coach does not change that - the OpenAI calls
 * live in main, and WebRTC's media path is not a CSP-fetched resource.
 */
import { ASSET_SCHEMES } from '../core/brand'

const sources = ASSET_SCHEMES.map((scheme) => `${scheme}:`).join(' ')
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${sources}`,
  `media-src 'self' ${sources}`,
  `frame-src ${sources}`,
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * Applied in dev too, deliberately.
 *
 * This used to be packaged-only, which meant a CSP regression was invisible in
 * `npm run dev`, invisible in `npm run smoke` (which runs an unpackaged build),
 * and first observable in a .dmg. Dev gets exactly three relaxations, all for
 * Vite: the dev server origin, its HMR websocket, and the inline module
 * preamble @vitejs/plugin-react injects. A smoke run has no dev server, so it
 * exercises RENDERER_CSP verbatim.
 */
export function cspFor(devUrl: string | undefined): string {
  if (!devUrl) return RENDERER_CSP
  let origin: string
  try {
    origin = new URL(devUrl).origin
  } catch {
    return RENDERER_CSP
  }
  const ws = origin.replace(/^http/, 'ws')
  return RENDERER_CSP.replace("default-src 'self'", `default-src 'self' ${origin}`)
    .replace("script-src 'self'", `script-src 'self' 'unsafe-inline' ${origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${origin} ${ws}`)
}
