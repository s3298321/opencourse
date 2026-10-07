/**
 * The opencourse:// scheme. Replaces apps/courses/viz.py - same containment check
 * (the zip-slip guard from ingest.py) and the same CSP for visualization
 * bundles, but reading straight from the course directory.
 *
 *   opencourse://<course-uuid>/assets/viz/event-loop/index.html
 */
import { protocol, net } from 'electron'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveInside } from '../core/safepath'
import { VIZ_BRIDGE_PATH, VIZ_BRIDGE_SCRIPT, injectVizBridge } from '../core/vizbridge'
import { packageDirectory, readDocument } from './course-store'
import { getCourse } from './courses'
import { ASSET_SCHEMES, BRAND } from '../core/brand'
import { THEME_HOST } from '../core/theme/compile'
import { themeImageFile } from './themes'

export const SCHEME = BRAND.scheme

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.map': 'application/json', '.txt': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}

/**
 * Locked down the way the Django viz view was: own bundle only, no network.
 *
 * No `frame-ancestors` here, unlike the server version. On the web it stopped
 * other sites from framing a viz; in the app the only framer is our own
 * renderer, which is served from file:// (or the dev server) and so can never
 * match `'self'` for a opencourse:// resource - the directive blocked every
 * visualization outright. Isolation comes from the sandboxed iframe instead:
 * `allow-scripts` with no `allow-same-origin`, so the bundle gets an opaque
 * origin and cannot reach the app, plus `connect-src 'none'` below.
 */
const VIZ_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'"
].join('; ')

/** Visualization bundles live under a `viz/` directory; this is what marks one. */
export function isVizPath(pathname: string): boolean {
  return pathname.includes('/viz/')
}

/**
 * A theme picture is drawn as a CSS background and never navigated to, but it
 * is served as if it might be: an SVG gets no script, no network and no
 * frames even if something did open it directly.
 */
const THEME_IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

async function serveThemeImage(url: URL): Promise<Response> {
  const [, id, ...rest] = url.pathname.split('/')
  let path: string
  try {
    path = rest.map(decodeURIComponent).join('/')
  } catch {
    return new Response('not found', { status: 404 })
  }
  const file = id ? themeImageFile(id, path) : null
  if (!file) return new Response('not found', { status: 404 })
  // Bytes only: main never decodes a theme's pictures. A grain texture asked
  // for at another strength (?strength=) is faded by the renderer, in its
  // sandbox, so the query is ignored here.
  const headers = {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': THEME_IMAGE_CSP,
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*'
  }
  const response = await net.fetch(pathToFileURL(file).toString())
  return new Response(response.body, { status: response.status, headers })
}

/** Must run before app.whenReady(). */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged(ASSET_SCHEMES.map((scheme) => (
    {
      scheme,
      // corsEnabled matters for more than fetch(): without it Chromium loads an
      // SVG from this scheme (it decodes, and it taints a canvas) but refuses to
      // paint it, so course cover art and .svg image blocks render as blank
      // boxes. The responses below allow any origin, which costs nothing here -
      // the app has no remote content, and the handler only ever serves files
      // inside a course directory.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  )))
}

export function registerProtocolHandler(): void {
  for (const scheme of ASSET_SCHEMES) protocol.handle(scheme, async (request) => {
    const url = new URL(request.url)
    // opencourse://themes/<theme-uuid>/<path>: the current user's installed
    // theme pictures. Answered before any course lookup, like the viz bridge.
    if (url.hostname === THEME_HOST) return serveThemeImage(url)
    let course: { root: string } | undefined = getCourse(url.hostname)
    if (!course) {
      try { readDocument(url.hostname); course = { root: packageDirectory(url.hostname) } } catch { /* unknown or unowned */ }
    }
    if (!course) return new Response('unknown course', { status: 404 })

    // The app's own file, on every course's host so a visualization loads it
    // as 'self' (core/vizbridge.ts). Answered before the course directory is
    // consulted, so a course cannot shadow it.
    if (url.pathname === VIZ_BRIDGE_PATH) {
      return new Response(VIZ_BRIDGE_SCRIPT, {
        status: 200,
        headers: {
          'content-type': 'text/javascript',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*'
        }
      })
    }

    const file = resolveInside(course.root, url.pathname.replace(/^\//, ''))
    if (!file) return new Response('not found', { status: 404 })

    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers({
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*'
    })
    if (!isVizPath(url.pathname)) return new Response(response.body, { status: response.status, headers })

    // Visualization bundles are third-party-ish code; keep them boxed in.
    headers.set('content-security-policy', VIZ_CSP)
    // A page gets the selection bridge, so "Ask about this" works on its text
    // without the course doing anything (core/vizbridge.ts). One tag loading
    // the script above; nothing else in the page is touched.
    const ext = extname(file).toLowerCase()
    if (response.ok && (ext === '.html' || ext === '.htm')) {
      return new Response(injectVizBridge(await response.text()), { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
  })
}
