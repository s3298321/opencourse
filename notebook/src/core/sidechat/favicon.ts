/**
 * The rules for fetching a cited page's favicon, kept apart from the fetching
 * (main/favicons.ts) so they are unit tests rather than network calls.
 *
 * The hosts come from OpenAI's citations, which is to say from the open web,
 * and main fetches from them on the learner's machine. So the first rule is
 * which hosts are fetched at all: public DNS names only, never an address and
 * never a name that resolves inside a home or office network. A citation
 * pointing at the router's admin page gets a letter tile, not a request.
 */

/** Small enough to inline as a data URL on every answer; larger is not a favicon. */
export const MAX_ICON_BYTES = 100_000
/** A page's `<head>` is near the top; this is plenty to find its icon links. */
export const MAX_PAGE_BYTES = 256_000

/** Suffixes that only ever name something on a local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.home.arpa']

/**
 * Whether a host may be fetched from. A public DNS name with a dot in it, made
 * of the characters such names are made of - which rules out IPv4 and IPv6
 * literals as well as `localhost` and the local-network suffixes.
 */
export function isFetchableHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name.length > 253 || !/^[a-z0-9.-]+$/.test(name)) return false
  if (!name.includes('.') || name.startsWith('.') || name.endsWith('.') || name.includes('..')) return false
  // Every label of an IPv4 address is numeric; a real TLD never is.
  if (/^\d+$/.test(name.split('.').at(-1)!)) return false
  if (name === 'localhost' || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false
  return name.split('.').every((label) => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'))
}

/** An https URL on a fetchable host, or null. */
export function fetchableUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base)
    return url.protocol === 'https:' && !url.username && !url.password && isFetchableHost(url.hostname) ? url : null
  } catch {
    return null
  }
}

/**
 * What an image is, from its first bytes. The Content-Type header is a claim
 * a server makes; this is what the bytes say, and only these formats are
 * shown. An SVG is safe to show: as an `<img>` source it cannot run script.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) return 'image/x-icon'
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'image/webp'
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart()
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!match) return null
  return (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/gi, '&').trim()
}

/** How well an icon link suits a 16px box drawn at 2x: about 32-64px wins. */
function score(rel: string[], sizes: string | null, type: string | null, href: string): number {
  let points = rel.includes('icon') ? 10 : 5
  const size = sizes && /(\d+)x\d+/i.exec(sizes)
  if (size) {
    const px = Number(size[1])
    points += px >= 32 && px <= 64 ? 6 : px > 64 && px <= 192 ? 3 : px >= 16 ? 1 : 0
  }
  if (sizes?.toLowerCase() === 'any' || type === 'image/svg+xml' || /\.svg(?:$|\?)/i.test(href)) points += 4
  return points
}

/**
 * The icons a page declares in its `<link>` tags, best first, as URLs
 * resolved against the page and limited to what may be fetched. A data URL
 * declared inline is kept as it is - it needs no fetch at all.
 */
export function iconLinks(html: string, base: string): string[] {
  const found: { url: string; points: number }[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/)
    if (!rel.includes('icon') && !rel.some((r) => r.startsWith('apple-touch-icon'))) continue
    const href = attribute(tag, 'href')
    if (!href) continue
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(href)) {
      found.push({ url: href, points: score(rel, attribute(tag, 'sizes'), attribute(tag, 'type'), href) })
      continue
    }
    const url = fetchableUrl(href, base)
    if (url) found.push({ url: url.toString(), points: score(rel, attribute(tag, 'sizes'), attribute(tag, 'type'), href) })
  }
  return [...new Map(found.sort((a, b) => b.points - a.points).map((f) => [f.url, f])).keys()]
}
