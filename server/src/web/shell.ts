/**
 * The one HTML document the web app has, filled in per request.
 *
 * Vite builds web/index.html into dist/web/index.html with two markers left in
 * it: `<!--oc-head-->` gets the title, description, canonical URL, robots rule
 * and link-preview tags, and `<!--oc-boot-->` gets the boot data (shared/boot.ts).
 * Every string from a course or an account is escaped here - the title through
 * `esc`, the boot JSON through `jsonForHtml`, so `</script>` in a course title
 * stays text - and the CSP the routes send is the backstop: no inline script
 * runs, whatever this file gets wrong.
 */
import { BOOT_ELEMENT_ID, type Boot } from '../../shared/boot'

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** JSON that cannot end the script element it sits in, or start an HTML comment. */
export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export interface ShellMeta {
  title: string
  description: string
  /** Absolute. */
  canonical: string
  /** Absolute URL of the link-preview picture. */
  image: string
  index: boolean
  type: 'website' | 'article'
  siteName: string
}

export function renderShell(template: string, meta: ShellMeta, boot: Boot): string {
  const description = meta.description.replace(/\s+/g, ' ').trim().slice(0, 200)
  const head = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(meta.canonical)}">`,
    `<meta name="robots" content="${meta.index ? 'index, follow' : 'noindex, nofollow'}">`,
    `<meta property="og:type" content="${meta.type}">`,
    `<meta property="og:site_name" content="${esc(meta.siteName)}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(meta.canonical)}">`,
    `<meta property="og:image" content="${esc(meta.image)}">`,
    `<meta name="twitter:card" content="${meta.image.endsWith('/mark-512.png') ? 'summary' : 'summary_large_image'}">`
  ].join('\n')
  const bootTag = `<script type="application/json" id="${BOOT_ELEMENT_ID}">${jsonForHtml(boot)}</script>`
  return template.replace('<!--oc-head-->', head).replace('<!--oc-boot-->', bootTag)
}

/** Shown at / by a development server that has no built web app yet. Still a valid page under the CSP. */
export const NO_WEB_APP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><!--oc-head--></head>
<body><h1>The web app is not built</h1>
<p>Run <code>npm run dev</code> in server/ and open the address Vite prints, or <code>npm run build</code> and restart this server.</p>
<p>The API is up at <code>/api/v1</code>.</p><!--oc-boot--></body></html>
`
