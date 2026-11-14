/**
 * The files a theme archive may hold, and what each one really is.
 *
 * A theme is pictures and fonts plus one JSON file. No HTML, CSS or script is
 * accepted at all - a course archive allows them for visualizations, a theme
 * has no use for them - so the narrower policy is the first guard on "a theme
 * changes how the app looks, not what it does". The second is that a file is
 * judged by its bytes, not its name: a `.png` that is really HTML is refused.
 */
import type { ArchivePolicy } from '../import'
import { sniffImage } from '../sidechat/favicon'

export const THEME_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
export const THEME_FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.woff2', '.woff', '.ttf', '.otf'])

export const THEME_POLICY: ArchivePolicy = {
  extensions: new Set(['.json', '.txt', '.md', ...THEME_IMAGE_EXTENSIONS, ...THEME_FONT_EXTENSIONS]),
  limits: { archiveBytes: 50 * 1024 * 1024, memberBytes: 25 * 1024 * 1024, members: 200 }
}

/** Bigger than any screen; a 100-megapixel JPEG is a memory problem, not a background. */
export const MAX_IMAGE_SIDE = 8192

export type ThemeAsset =
  | { kind: 'image'; mime: string; width: number | null; height: number | null }
  | { kind: 'font'; mime: string }

/** The index normalize and compile use instead of the filesystem: path -> what it is. */
export type AssetIndex = ReadonlyMap<string, ThemeAsset>

/** WOFF2, WOFF, TrueType and OpenType by their signatures. Collections are refused. */
export function sniffFont(bytes: Uint8Array): string | null {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  if (tag === 'wOF2') return 'font/woff2'
  if (tag === 'wOFF') return 'font/woff'
  if (tag === 'OTTO') return 'font/otf'
  if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'font/ttf'
  return null
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, i: number): number => ((u16be(b, i) << 16) >>> 0) + u16be(b, i + 2)

/**
 * Pixel dimensions from the header, without decoding. Null when the format
 * does not say (an SVG) or the header is not where it should be.
 */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && bytes.length >= 24) return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
  if (mime === 'image/gif' && bytes.length >= 10) return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    if (chunk === 'VP8 ') return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
    return null
  }
  if (mime === 'image/jpeg') {
    // Walk the segments to the first start-of-frame marker.
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]!
      const length = u16be(bytes, i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) }
      }
      i += 2 + length
    }
    return null
  }
  return null
}

const IMAGE_MIME_FOR: Record<string, string[]> = {
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'], '.gif': ['image/gif'], '.svg': ['image/svg+xml']
}

/**
 * What a theme file is, or why it is refused. The extension must agree with
 * the bytes, so a renamed file is caught here rather than by the decoder.
 */
export function describeAsset(path: string, ext: string, bytes: Uint8Array): ThemeAsset | { error: string } | null {
  if (THEME_IMAGE_EXTENSIONS.has(ext)) {
    const mime = sniffImage(bytes)
    if (!mime || !IMAGE_MIME_FOR[ext]!.includes(mime)) return { error: `${path} is not the image its name says it is` }
    const size = imageSize(bytes, mime)
    if (size && (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE)) {
      return { error: `${path} is ${size.width}×${size.height}; images may be at most ${MAX_IMAGE_SIDE} pixels on a side` }
    }
    return { kind: 'image', mime, width: size?.width ?? null, height: size?.height ?? null }
  }
  if (THEME_FONT_EXTENSIONS.has(ext)) {
    const mime = sniffFont(bytes)
    if (!mime) return { error: `${path} is not a font` }
    return { kind: 'font', mime }
  }
  return null
}

/** Grain strength a texture is drawn at as authored; core/theme/compile.ts scales from it. */
export const TEXTURE_REFERENCE = 0.12
/** The most a texture can be strengthened: the format's top amount over the reference. */
export const MAX_TEXTURE_STRENGTH = 0.4 / TEXTURE_REFERENCE

/**
 * Scales the opacity of straight (not premultiplied) RGBA pixels in place, as
 * canvas getImageData hands them over - how the renderer draws a grain texture
 * at a strength other than its own.
 */
export function scaleAlpha(pixels: Uint8ClampedArray | Uint8Array, strength: number): void {
  const s = Math.min(MAX_TEXTURE_STRENGTH, Math.max(0, strength))
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = Math.min(255, Math.round(pixels[i]! * s))
}
