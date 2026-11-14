/**
 * theme.json, read the way every JSON file here is read: as whatever can still
 * be made sense of. A bad field costs that field and a note on the theme's card,
 * never the theme - only a file that is not a theme at all, or one made for a
 * newer format, is refused. Unknown keys are ignored so an older app can still
 * show a newer theme.
 *
 * Everything that leaves this module is parsed: colours are numbers, numbers
 * are clamped, paths name a file of the right kind in the archive, and font
 * names are limited to characters that cannot break out of a quoted string.
 */
import { parseColor, type Rgba } from './color'
import type { AssetIndex } from './assets'
import {
  FONT_SLOTS, GRADIENT_TOKENS, REGIONS, SURFACE_NAMES, isColorToken,
  type ColorToken, type FontSlotName, type RegionName, type SurfaceName
} from './tokens'
import {
  FITS, POSITIONS, type Appearance, type FontFaceSpec, type FontSlot, type GrainSpec, type Paint,
  type Picture, type SurfaceSpec, type Theme, type ThemeNote, type WindowSpec
} from './types'

export const THEME_FORMAT = 1
/** The top level of theme.json; theme-schema.json must list exactly these. */
export const THEME_KEYS = [
  '$schema', 'format', 'id', 'name', 'version', 'author', 'description', 'appearance', 'preview',
  'palette', 'tokens', 'reducedTransparency', 'increasedContrast', 'window', 'grain', 'surfaces', 'fonts', 'logo'
] as const
export const THEME_SCHEMA_ID = 'urn:opencourse:theme:1.0'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'BlinkMacSystemFont'
])

/** What a theme leaves out of its palette, per appearance. */
export const DEFAULT_SEEDS: Record<Appearance, { background: Rgba; text: Rgba; accent: Rgba }> = {
  dark: { background: parseColor('#18181b')!, text: parseColor('#dedee3')!, accent: parseColor('#e4e4e8')! },
  light: { background: parseColor('#f4f4f5')!, text: parseColor('#1f1f23')!, accent: parseColor('#2f2f35')! }
}

/** Ranges for every number a theme may give, with the value used when it gives none. */
export const RANGES = {
  grainAmount: { min: 0, max: 0.4, fallback: 0.12 },
  grainScale: { min: 0.5, max: 3, fallback: 1 },
  imageScale: { min: 0.25, max: 4, fallback: 1 },
  windowBlur: { min: 0, max: 40, fallback: 0 },
  windowDim: { min: 0, max: 1, fallback: 0 },
  popoverBlur: { min: 0, max: 40, fallback: 20 },
  opacity: { min: 0, max: 1, fallback: 1 },
  lineHeight: { min: 1, max: 2.2, fallback: 1.55 },
  weight: { min: 100, max: 900, fallback: 400 },
  letterSpacing: { min: -0.1, max: 0.3, fallback: 0 }
} as const

const SLOT_FIELDS: Record<FontSlotName, ReadonlyArray<keyof FontSlot>> = {
  ui: ['family', 'lineHeight'],
  reading: ['family', 'lineHeight'],
  heading: ['family', 'weight', 'letterSpacing'],
  code: ['family'],
  brand: ['family', 'weight', 'letterSpacing']
}

/**
 * Slots that had a `size` in the first version of the format. It is still
 * accepted - a theme written then must not fail - but read as nothing: text
 * size belongs to the reader, who sets it beside the lesson.
 */
const RETIRED_SIZE: ReadonlySet<FontSlotName> = new Set(['ui', 'reading', 'code'])

type Raw = Record<string, unknown>
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Printable text, trimmed, at most `max` characters; undefined when there is none. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean ? clean.slice(0, max) : undefined
}

class Reader {
  readonly notes: ThemeNote[] = []
  constructor(private readonly assets: AssetIndex) {}

  warn(message: string): void {
    this.notes.push({ level: 'warning', message })
  }

  /** Unknown keys are ignored, but said, so a typo is visible. */
  only(where: string, raw: Raw, known: readonly string[]): void {
    for (const key of Object.keys(raw)) if (!known.includes(key)) this.warn(`${where}.${key} is not part of the format and was ignored.`)
  }

  number(where: string, value: unknown, range: { min: number; max: number }): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.warn(`${where} should be a number.`)
      return undefined
    }
    if (value < range.min || value > range.max) {
      const kept = Math.min(range.max, Math.max(range.min, value))
      this.warn(`${where} ${value} is outside ${range.min}–${range.max}; ${kept} is used.`)
      return kept
    }
    return value
  }

  color(where: string, value: unknown): Rgba | undefined {
    if (value === undefined) return undefined
    const parsed = parseColor(value)
    if (!parsed) this.warn(`${where} is not a colour this app reads (use #rrggbb, #rrggbbaa, rgb(), rgba() or hsl()).`)
    return parsed ?? undefined
  }

  paint(where: string, value: unknown, gradient: boolean): Paint | undefined {
    if (gradient && isObject(value)) {
      const from = this.color(`${where}.from`, value['from'])
      const to = this.color(`${where}.to`, value['to'])
      return from && to ? { from, to } : undefined
    }
    return this.color(where, value)
  }

  asset(where: string, value: unknown, kind: 'image' | 'font'): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      this.warn(`${where} should be a path inside the theme.`)
      return undefined
    }
    const path = value.replace(/^\.\//, '')
    const found = this.assets.get(path)
    if (!found) this.warn(`${where} names ${value}, which is not in the theme.`)
    else if (found.kind !== kind) this.warn(`${where} names ${value}, which is not ${kind === 'image' ? 'an image' : 'a font'}.`)
    else return path
    return undefined
  }

  oneOf<T extends string>(where: string, value: unknown, options: readonly T[], fallback: T): T {
    if (value === undefined) return fallback
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
    this.warn(`${where} should be one of ${options.join(', ')}; ${fallback} is used.`)
    return fallback
  }

  families(where: string, value: unknown): string[] | undefined {
    const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
    if (!list) {
      if (value !== undefined) this.warn(`${where} should be a font name or a list of them.`)
      return undefined
    }
    const kept: string[] = []
    for (const name of list.slice(0, 8)) {
      if (typeof name === 'string' && (GENERIC_FAMILIES.has(name) || FAMILY.test(name))) kept.push(name)
      else this.warn(`${where}: ${JSON.stringify(name)} is not a font name this app accepts (letters, digits, spaces, . _ -).`)
    }
    return kept.length ? kept : undefined
  }

  picture(where: string, value: unknown, extra: readonly string[] = []): Picture | undefined {
    if (value === undefined) return undefined
    if (!isObject(value)) {
      this.warn(`${where} should be an object with a src.`)
      return undefined
    }
    this.only(where, value, ['src', 'fit', 'position', 'scale', 'tint', ...extra])
    const src = this.asset(`${where}.src`, value['src'], 'image')
    if (!src) return undefined
    const tint = this.color(`${where}.tint`, value['tint'])
    return {
      src,
      fit: this.oneOf(`${where}.fit`, value['fit'], FITS, 'cover'),
      position: this.oneOf(`${where}.position`, value['position'], POSITIONS, 'center'),
      scale: this.number(`${where}.scale`, value['scale'], RANGES.imageScale) ?? RANGES.imageScale.fallback,
      ...(tint ? { tint } : {})
    }
  }

  tokenMap(where: string, value: unknown): Partial<Record<ColorToken, Paint>> {
    const out: Partial<Record<ColorToken, Paint>> = {}
    if (value === undefined) return out
    if (!isObject(value)) {
      this.warn(`${where} should be an object of token: colour.`)
      return out
    }
    for (const [key, raw] of Object.entries(value)) {
      if (!isColorToken(key)) {
        this.warn(`${where}.${key} is not a colour token; see the format for the list.`)
        continue
      }
      const paint = this.paint(`${where}.${key}`, raw, GRADIENT_TOKENS.has(key))
      if (paint) out[key] = paint
    }
    return out
  }
}

function readWindow(read: Reader, raw: unknown): WindowSpec {
  if (raw === undefined) return { material: 'vibrancy' }
  if (!isObject(raw)) {
    read.warn('window should be an object.')
    return { material: 'vibrancy' }
  }
  read.only('window', raw, ['material', 'color', 'image'])
  const color = read.color('window.color', raw['color'])
  let material = read.oneOf('window.material', raw['material'], ['vibrancy', 'solid', 'image'] as const, raw['image'] ? 'image' : 'vibrancy')
  const picture = read.picture('window.image', raw['image'], ['blur', 'dim'])
  const image = picture && isObject(raw['image']) ? {
    ...picture,
    blur: read.number('window.image.blur', raw['image']['blur'], RANGES.windowBlur) ?? RANGES.windowBlur.fallback,
    dim: read.number('window.image.dim', raw['image']['dim'], RANGES.windowDim) ?? RANGES.windowDim.fallback
  } : undefined
  if (material === 'image' && !image) {
    read.warn('window.material is image but there is no usable window.image; a solid window is used.')
    material = 'solid'
  }
  if (material !== 'image' && image) read.warn(`window.image is only used when window.material is image.`)
  return { material, ...(color ? { color } : {}), ...(material === 'image' && image ? { image } : {}) }
}

function readGrain(read: Reader, raw: unknown): GrainSpec {
  const fallback = { amount: RANGES.grainAmount.fallback, scale: RANGES.grainScale.fallback }
  if (raw === undefined) return fallback
  if (!isObject(raw)) {
    read.warn('grain should be an object.')
    return fallback
  }
  read.only('grain', raw, ['amount', 'scale', 'texture'])
  const texture = read.asset('grain.texture', raw['texture'], 'image')
  return {
    amount: read.number('grain.amount', raw['amount'], RANGES.grainAmount) ?? fallback.amount,
    scale: read.number('grain.scale', raw['scale'], RANGES.grainScale) ?? fallback.scale,
    ...(texture ? { texture } : {})
  }
}

function readSurface(read: Reader, name: SurfaceName, raw: unknown): SurfaceSpec | undefined {
  const where = `surfaces.${name}`
  if (!isObject(raw)) {
    read.warn(`${where} should be an object.`)
    return undefined
  }
  const region = (REGIONS as Record<string, (typeof REGIONS)[RegionName]>)[name]
  const known = region ? ['color', 'opacity', 'grain', ...(region.pictures ? ['image'] : []), ...(name === 'popover' ? ['blur'] : [])] : ['color', 'opacity']
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue
    if (key === 'image' && region && !region.pictures) read.warn(`${where} cannot take a picture${region.opaque ? ': it is a reading surface and stays plain' : ''}; only colour and grain.`)
    else if (key === 'grain' || key === 'image') read.warn(`${where} only takes a colour.`)
    else read.warn(`${where}.${key} is not part of the format and was ignored.`)
  }
  const spec: SurfaceSpec = {}
  const color = read.color(`${where}.color`, raw['color'])
  if (color) spec.color = color
  const opacity = read.number(`${where}.opacity`, raw['opacity'], RANGES.opacity)
  if (opacity !== undefined) spec.opacity = opacity
  if (region) {
    const grain = read.number(`${where}.grain`, raw['grain'], RANGES.grainAmount)
    if (grain !== undefined) spec.grain = grain
    if (region.pictures) {
      const image = read.picture(`${where}.image`, raw['image'])
      if (image) spec.image = image
    }
    if (name === 'popover') {
      const blur = read.number(`${where}.blur`, raw['blur'], RANGES.popoverBlur)
      if (blur !== undefined) spec.blur = blur
    }
  }
  return Object.keys(spec).length ? spec : undefined
}

function readWeight(read: Reader, where: string, value: unknown): string {
  if (value === undefined || value === 'normal') return '400'
  if (value === 'bold') return '700'
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000) return String(value)
  const range = typeof value === 'string' ? /^(\d{1,4}) (\d{1,4})$/.exec(value) : null
  if (range && Number(range[1]) >= 1 && Number(range[2]) <= 1000 && Number(range[1]) <= Number(range[2])) return `${range[1]} ${range[2]}`
  read.warn(`${where} should be a weight (400), a range ("100 900"), normal or bold; 400 is used.`)
  return '400'
}

function readFonts(read: Reader, raw: unknown): Theme['fonts'] {
  const fonts: Theme['fonts'] = { faces: [] }
  if (raw === undefined) return fonts
  if (!isObject(raw)) {
    read.warn('fonts should be an object.')
    return fonts
  }
  read.only('fonts', raw, ['faces', ...FONT_SLOTS])
  const faces = raw['faces']
  if (faces !== undefined && !Array.isArray(faces)) read.warn('fonts.faces should be a list.')
  for (const [i, face] of (Array.isArray(faces) ? faces : []).slice(0, 32).entries()) {
    const where = `fonts.faces[${i}]`
    if (!isObject(face)) {
      read.warn(`${where} should be an object.`)
      continue
    }
    read.only(where, face, ['family', 'src', 'weight', 'style'])
    const family = typeof face['family'] === 'string' && FAMILY.test(face['family']) && !GENERIC_FAMILIES.has(face['family']) ? face['family'] : undefined
    if (!family) read.warn(`${where}.family should be a font name (letters, digits, spaces, . _ -).`)
    const src = read.asset(`${where}.src`, face['src'], 'font')
    if (!family || !src) continue
    const entry: FontFaceSpec = {
      family,
      src,
      weight: readWeight(read, `${where}.weight`, face['weight']),
      style: read.oneOf(`${where}.style`, face['style'], ['normal', 'italic'] as const, 'normal')
    }
    fonts.faces.push(entry)
  }
  let sized = false
  for (const slot of FONT_SLOTS) {
    const value = raw[slot]
    if (value === undefined) continue
    const where = `fonts.${slot}`
    if (!isObject(value)) {
      read.warn(`${where} should be an object.`)
      continue
    }
    const fields = SLOT_FIELDS[slot]
    // Taken out before the unknown-key check, so a size is one plain note for
    // the whole theme rather than "not part of the format" once per slot.
    const { size, ...rest } = value
    if (size !== undefined && RETIRED_SIZE.has(slot)) sized = true
    read.only(where, RETIRED_SIZE.has(slot) ? rest : value, fields as string[])
    const out: FontSlot = {}
    const family = fields.includes('family') ? read.families(`${where}.family`, value['family']) : undefined
    if (family) out.family = family
    const weight = fields.includes('weight') ? read.number(`${where}.weight`, value['weight'], RANGES.weight) : undefined
    if (weight !== undefined) out.weight = Math.round(weight)
    const lineHeight = fields.includes('lineHeight') ? read.number(`${where}.lineHeight`, value['lineHeight'], RANGES.lineHeight) : undefined
    if (lineHeight !== undefined) out.lineHeight = lineHeight
    const spacing = fields.includes('letterSpacing') ? read.number(`${where}.letterSpacing`, value['letterSpacing'], RANGES.letterSpacing) : undefined
    if (spacing !== undefined) out.letterSpacing = spacing
    if (Object.keys(out).length) fonts[slot] = out
  }
  if (sized) read.warn('Text size is set by the reader, so the font sizes in this theme are ignored.')
  return fonts
}

/**
 * Parses theme.json against the files actually in the archive. Refuses only
 * what is not a theme; everything else degrades with a note.
 */
export function normalizeTheme(raw: unknown, assets: AssetIndex): { theme: Theme; notes: ThemeNote[] } | { error: string } {
  if (!isObject(raw)) return { error: 'theme.json is not a JSON object.' }
  const format = raw['format']
  if (typeof format !== 'number') return { error: 'theme.json has no "format": this does not look like an OpenCourse theme.' }
  if (format > THEME_FORMAT) return { error: `This theme uses format ${format}, which needs a newer OpenCourse (this one reads format ${THEME_FORMAT}).` }
  if (format !== THEME_FORMAT) return { error: `Unknown theme format ${format}.` }
  const id = raw['id']
  if (typeof id !== 'string' || id.length > 64 || !SLUG.test(id)) return { error: 'theme.json needs an "id" made of lowercase letters, digits and hyphens.' }
  const name = text(raw['name'], 80)
  if (!name) return { error: 'theme.json needs a "name".' }

  const read = new Reader(assets)
  read.only('theme', raw, THEME_KEYS)
  const appearance = read.oneOf('appearance', raw['appearance'], ['dark', 'light'] as const, 'dark')

  const seeds = DEFAULT_SEEDS[appearance]
  const rawPalette = isObject(raw['palette']) ? raw['palette'] : {}
  if (raw['palette'] !== undefined && !isObject(raw['palette'])) read.warn('palette should be an object.')
  read.only('palette', rawPalette, ['background', 'text', 'accent', 'muted', 'success', 'danger'])
  const seed = (key: 'background' | 'text' | 'accent'): Rgba => {
    const value = read.color(`palette.${key}`, rawPalette[key])
    if (!value && rawPalette[key] === undefined) read.warn(`palette.${key} is missing; the ${appearance} default is used.`)
    return value ?? seeds[key]
  }
  const palette: Theme['palette'] = { background: seed('background'), text: seed('text'), accent: seed('accent') }
  for (const key of ['muted', 'success', 'danger'] as const) {
    const value = read.color(`palette.${key}`, rawPalette[key])
    if (value) palette[key] = value
  }

  const surfaces: Theme['surfaces'] = {}
  const rawSurfaces = raw['surfaces']
  if (rawSurfaces !== undefined && !isObject(rawSurfaces)) read.warn('surfaces should be an object.')
  for (const [key, value] of Object.entries(isObject(rawSurfaces) ? rawSurfaces : {})) {
    if (!(SURFACE_NAMES as string[]).includes(key)) {
      read.warn(`surfaces.${key} is not a surface; the surfaces are ${SURFACE_NAMES.join(', ')}.`)
      continue
    }
    const spec = readSurface(read, key as SurfaceName, value)
    if (spec) surfaces[key as SurfaceName] = spec
  }

  const rawLogo = raw['logo']
  let logo: Theme['logo']
  if (isObject(rawLogo)) {
    read.only('logo', rawLogo, ['mark'])
    const mark = read.asset('logo.mark', rawLogo['mark'], 'image')
    if (mark) logo = { mark }
  } else if (rawLogo !== undefined) read.warn('logo should be an object with a mark.')

  const preview = read.asset('preview', raw['preview'], 'image')
  const version = text(raw['version'], 32)
  const author = text(raw['author'], 80)
  const description = text(raw['description'], 400)

  const theme: Theme = {
    format: THEME_FORMAT,
    id,
    name,
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
    appearance,
    ...(preview ? { preview } : {}),
    palette,
    tokens: read.tokenMap('tokens', raw['tokens']),
    reducedTransparency: read.tokenMap('reducedTransparency', raw['reducedTransparency']),
    increasedContrast: read.tokenMap('increasedContrast', raw['increasedContrast']),
    window: readWindow(read, raw['window']),
    grain: readGrain(read, raw['grain']),
    surfaces,
    fonts: readFonts(read, raw['fonts']),
    ...(logo ? { logo } : {})
  }
  return { theme, notes: read.notes }
}

