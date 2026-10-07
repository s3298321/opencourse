/**
 * Colours, as numbers.
 *
 * Every colour a theme names is parsed here and re-serialised by
 * `colorCss`, so no string a theme wrote ever reaches the stylesheet as it was
 * written. A value that does not parse is not a colour - `red;}body{…` is
 * refused here rather than escaped somewhere later.
 */

/** sRGB channels 0-255 (rounded on output), alpha 0-1. */
export interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

/** The few names a hand-written theme reaches for; anything else must be numeric. */
const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 }
}

function channel(raw: string, scale: number): number | null {
  const text = raw.trim()
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)%$/.test(text)) return clamp((parseFloat(text) / 100) * scale, 0, scale)
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return clamp(parseFloat(text), 0, scale)
  return null
}

function alphaOf(raw: string | undefined): number | null {
  if (raw === undefined) return 1
  const text = raw.trim()
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)%$/.test(text)) return clamp(parseFloat(text) / 100, 0, 1)
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return clamp(parseFloat(text), 0, 1)
  return null
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Splits `a b c / d` and `a, b, c, d` alike. */
function parts(body: string): { values: string[]; alpha?: string } | null {
  if (body.includes(',')) {
    const values = body.split(',').map((part) => part.trim())
    if (values.length !== 3 && values.length !== 4) return null
    return { values: values.slice(0, 3), alpha: values[3] }
  }
  const [main, alpha, ...rest] = body.split('/')
  if (rest.length || main === undefined) return null
  const values = main.trim().split(/\s+/)
  return values.length === 3 ? { values, alpha } : null
}

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, `hsl()`/`hsla()`
 * (comma or space syntax) and the names above. Null for anything else.
 */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string' || input.length > 64) return null
  const text = input.trim().toLowerCase()
  if (NAMED[text]) return { ...NAMED[text]! }

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const digits = hex[1]!
    if (![3, 4, 6, 8].includes(digits.length)) return null
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits
    const byte = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16)
    return { r: byte(0), g: byte(1), b: byte(2), a: full.length === 8 ? Math.round((byte(3) / 255) * 1000) / 1000 : 1 }
  }

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text)
  if (!fn) return null
  const split = parts(fn[2]!)
  if (!split) return null
  const a = alphaOf(split.alpha)
  if (a === null) return null
  if (fn[1]!.startsWith('rgb')) {
    const [r, g, b] = split.values.map((value) => channel(value, 255))
    if (r == null || g == null || b == null) return null
    return { r, g, b, a }
  }
  const hue = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:deg)?$/.test(split.values[0]!) ? parseFloat(split.values[0]!) : null
  const s = channel(split.values[1]!, 100)
  const l = channel(split.values[2]!, 100)
  if (hue === null || s === null || l === null || !split.values[1]!.endsWith('%') || !split.values[2]!.endsWith('%')) return null
  const [r, g, b] = hslToRgb(hue, s / 100, l / 100)
  return { r, g, b, a }
}

const hex2 = (value: number): string => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')
const trimNumber = (value: number): string => String(Math.round(value * 1000) / 1000)

/**
 * The one way a colour is written into CSS: `#rrggbb` when opaque, otherwise
 * `rgba(r, g, b, a)` with the spacing the stylesheet itself uses.
 */
export function colorCss(color: Rgba): string {
  const r = Math.round(clamp(color.r, 0, 255))
  const g = Math.round(clamp(color.g, 0, 255))
  const b = Math.round(clamp(color.b, 0, 255))
  if (color.a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return `rgba(${r}, ${g}, ${b}, ${trimNumber(clamp(color.a, 0, 1))})`
}

/** `r g b`, for `rgb(var(--x) / a)` - a colour token whose alpha the rule supplies. */
export function rgbTriplet(color: Rgba): string {
  return `${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)}`
}

export function withAlpha(color: Rgba, a: number): Rgba {
  return { ...color, a: clamp(a, 0, 1) }
}

/** `from` moved `amount` (0-1) of the way to `to`, alpha included. */
export function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  const t = clamp(amount, 0, 1)
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t
  }
}

/** What `top` looks like painted over `base`, as an opaque colour. */
export function composite(top: Rgba, base: Rgba): Rgba {
  const under = base.a >= 1 ? base : composite(base, { r: 0, g: 0, b: 0, a: 1 })
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1
  }
}

function linear(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG contrast ratio, 1-21. Both colours are treated as opaque. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The candidate that reads best on `background`. */
export function bestOn(background: Rgba, candidates: Rgba[]): Rgba {
  let best = candidates[0]!
  for (const candidate of candidates) if (contrast(candidate, background) > contrast(best, background)) best = candidate
  return best
}
