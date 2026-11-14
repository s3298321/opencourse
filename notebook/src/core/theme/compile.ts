/**
 * A theme, as the stylesheet the renderer injects.
 *
 * The output is `:root { --token: value }` and two media blocks of the same
 * shape - no selector a theme chose, no property that is not in
 * THEME_PROPERTIES. Every value is built here from parsed numbers: colours are
 * re-serialised, pictures become URLs the app composes from paths it checked,
 * font names were limited to quote-safe characters. `assertSafe` checks the
 * result anyway, because "a theme cannot change what the app does" should not
 * rest on every branch above it being right.
 *
 * A compiled theme is complete. Every colour token is written, derived when the
 * theme did not say, so nothing falls through to the default's dark values.
 */
import { BRAND } from '../brand'
import { colorCss, composite, rgbTriplet, withAlpha, type Rgba } from './color'
import { deriveIncreasedContrast, derivePalette } from './derive'
import { GRAIN_TILE, chevronSvg, grainSvg, svgUrl } from './grain'
import { TEXTURE_REFERENCE, type AssetIndex } from './assets'
import {
  COLOR_TOKENS, DEFAULT_MONO_STACK, DEFAULT_UI_STACK, FILLS, OPAQUE_TOKENS, REGIONS, SURFACE_TOKENS,
  THEME_PROPERTIES, TRIPLET_TOKENS, tokenProperty, type ColorToken, type FillName, type RegionName
} from './tokens'
import type { Appearance, Fit, Paint, Picture, Position, SurfaceSpec, Theme, ThemeNote } from './types'

export interface CompiledFace {
  family: string
  /** The font's path inside the theme; main hands the renderer its bytes. */
  src: string
  weight: string
  style: 'normal' | 'italic'
}

export interface CompiledTheme {
  css: string
  appearance: Appearance
  faces: CompiledFace[]
  /** The titlebar mark, or null for the app's own. */
  logo: string | null
  /** What main does to the window itself. */
  native: { appearance: Appearance; vibrancy: boolean; background: string }
  notes: ThemeNote[]
  /** The three blocks as maps, for the tests and the contrast audit. */
  values: Record<string, string>
  reducedTransparency: Record<string, string>
  increasedContrast: Record<string, string>
}

export interface CompileOptions {
  /** The URL a theme file is served at: opencourse://themes/<uuid>/<path>. */
  url: (path: string) => string
  assets: AssetIndex
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const GENERIC = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|-apple-system|BlinkMacSystemFont)$/

/** The reserved asset host for theme pictures; it can never be a course UUID. */
export const THEME_HOST = 'themes'

/** Where a theme's own files are served: opencourse://themes/<uuid>/<path>. */
export const THEME_URL_PREFIX = `${BRAND.scheme}://${THEME_HOST}/`

const isGradient = (paint: Paint): paint is { from: Rgba; to: Rgba } => 'from' in paint
const px = (value: number): string => `${Math.round(value * 100) / 100}px`
const num = (value: number): string => String(Math.round(value * 1000) / 1000)

function paintCss(token: ColorToken, paint: Paint): string {
  if (TRIPLET_TOKENS.has(token)) return rgbTriplet(isGradient(paint) ? paint.from : paint)
  if (isGradient(paint)) return `linear-gradient(160deg, ${colorCss(paint.from)} 0%, ${colorCss(paint.to)} 100%)`
  // `selected` is painted with the background shorthand and read as a
  // gradient elsewhere, so a flat colour is still written as one.
  if (token === 'selected') return `linear-gradient(160deg, ${colorCss(paint)} 0%, ${colorCss(paint)} 100%)`
  return colorCss(paint)
}

const opaqueOver = (color: Rgba, base: Rgba): Rgba => (color.a >= 1 ? color : composite(color, base))
const flat = (paint: Paint): Rgba => (isGradient(paint) ? paint.from : paint)

function families(list: string[], fallback: string): string {
  return [...list.map((name) => (GENERIC.test(name) ? name : `"${name}"`)), fallback].join(', ')
}

const POSITION_CSS: Record<Position, string> = {
  center: '50% 50%', top: '50% 0%', bottom: '50% 100%', left: '0% 50%', right: '100% 50%',
  'top left': '0% 0%', 'top right': '100% 0%', 'bottom left': '0% 100%', 'bottom right': '100% 100%'
}

interface Layer { image: string; size: string; position: string; repeat: string }

function pictureLayer(picture: Picture, options: CompileOptions): Layer {
  const asset = options.assets.get(picture.src)
  const natural = asset?.kind === 'image' && asset.width && asset.height ? { w: asset.width, h: asset.height } : { w: 256, h: 256 }
  const size: Record<Fit, string> = {
    cover: 'cover',
    contain: 'contain',
    stretch: '100% 100%',
    tile: `${px(natural.w * picture.scale)} ${px(natural.h * picture.scale)}`
  }
  return {
    image: `url("${options.url(picture.src)}")`,
    size: size[picture.fit],
    position: POSITION_CSS[picture.position],
    repeat: picture.fit === 'tile' ? 'repeat' : 'no-repeat'
  }
}

/**
 * A grain texture at a strength: drawn as authored at 0.12, and
 * with its opacity scaled for any other amount. CSS cannot fade one background
 * layer, so the renderer does it on a canvas (theme/ThemeProvider.tsx), reading
 * the strength off this URL - in its sandbox, where the picture is decoded anyway.
 */
function textureImage(path: string, amount: number, options: CompileOptions): string {
  const strength = Math.round((amount / TEXTURE_REFERENCE) * 100) / 100
  return strength === 1 ? `url("${options.url(path)}")` : `url("${options.url(path)}?strength=${strength}")`
}

const tintLayer = (tint: Rgba): Layer => ({
  image: `linear-gradient(${colorCss(tint)}, ${colorCss(tint)})`, size: 'auto', position: '0% 0%', repeat: 'repeat'
})

function writeLayers(out: Record<string, string>, prefix: string, layers: Layer[]): void {
  out[`--${prefix}-image`] = layers.length ? layers.map((l) => l.image).join(', ') : 'none'
  out[`--${prefix}-image-size`] = layers.length ? layers.map((l) => l.size).join(', ') : 'auto'
  out[`--${prefix}-image-position`] = layers.length ? layers.map((l) => l.position).join(', ') : '0% 0%'
  out[`--${prefix}-image-repeat`] = layers.length ? layers.map((l) => l.repeat).join(', ') : 'repeat'
}

/**
 * Defence in depth: the property is on the list, and the value cannot end the
 * declaration or the block. Data URLs are percent-encoded, so the characters
 * that matter never appear in them.
 */
function assertSafe(block: Record<string, string>): void {
  for (const [property, value] of Object.entries(block)) {
    if (!THEME_PROPERTIES.has(property)) throw new Error(`compiled theme wrote ${property}, which is not a theme property`)
    if (/[;{}\\<>\n\r]/.test(value)) throw new Error(`compiled theme value for ${property} is not safe: ${value.slice(0, 80)}`)
    for (const match of value.matchAll(/url\("([^"]*)"\)/g)) {
      if (!match[1]!.startsWith('data:image/svg+xml,') && !match[1]!.startsWith(THEME_URL_PREFIX)) throw new Error(`compiled theme points ${property} outside the theme`)
    }
  }
}

function block(selector: string, values: Record<string, string>): string {
  const lines = Object.entries(values).map(([property, value]) => `  ${property}: ${value};`)
  return lines.length ? `${selector} {\n${lines.join('\n')}\n}` : ''
}

export function compileTheme(theme: Theme, options: CompileOptions): CompiledTheme {
  const notes: ThemeNote[] = []
  const tokens = derivePalette(theme)
  Object.assign(tokens, theme.tokens)

  // Fills: surfaces that are just a token.
  for (const [name, token] of Object.entries(FILLS) as [FillName, ColorToken][]) {
    const spec = theme.surfaces[name]
    if (!spec) continue
    const base = spec.color ?? flat(tokens[token])
    tokens[token] = spec.opacity !== undefined ? withAlpha(base, spec.opacity) : base
  }

  // Regions whose colour is a shared token: titlebar, popover, reading.
  const regionColor: Partial<Record<RegionName, Rgba>> = {}
  for (const name of Object.keys(REGIONS) as RegionName[]) {
    const spec = theme.surfaces[name]
    if (!spec || (spec.color === undefined && spec.opacity === undefined)) continue
    const owner = name === 'titlebar' ? 'chrome' : name === 'popover' ? 'popover' : name === 'reading' ? 'bg' : null
    const base = spec.color ?? flat(tokens[owner ?? 'glass'])
    const color = spec.opacity !== undefined ? withAlpha(base, spec.opacity) : base
    if (owner) tokens[owner] = color
    else regionColor[name] = color
  }

  const windowColor = opaqueOver(theme.window.color ?? flat(tokens.bg), BLACK)

  // Reading and editing surfaces stay opaque, whatever the theme asked for.
  for (const token of OPAQUE_TOKENS) {
    const color = flat(tokens[token])
    if (color.a < 1) {
      tokens[token] = composite(color, windowColor)
      notes.push({ level: 'info', message: `${token === 'bg' ? 'The reading surface' : 'Code surfaces'} must be opaque, so ${colorCss(color)} is drawn as ${colorCss(tokens[token] as Rgba)}.` })
    }
  }

  const values: Record<string, string> = {}
  for (const token of COLOR_TOKENS) values[tokenProperty(token)] = paintCss(token, tokens[token])
  values['--color-scheme'] = theme.appearance

  // Grain: the generated noise at the theme's strength, or its own texture.
  const grain = theme.grain
  const texture = grain.texture ? options.assets.get(grain.texture) : undefined
  if (grain.texture) {
    const w = texture?.kind === 'image' && texture.width ? texture.width : GRAIN_TILE
    const h = texture?.kind === 'image' && texture.height ? texture.height : GRAIN_TILE
    values['--glass-grain'] = grain.amount > 0 ? textureImage(grain.texture, grain.amount, options) : 'none'
    values['--grain-size'] = `${px(w * grain.scale)} ${px(h * grain.scale)}`
  } else {
    values['--glass-grain'] = grain.amount > 0 ? svgUrl(grainSvg(grain.amount, theme.appearance)) : 'none'
    values['--grain-size'] = `${px(GRAIN_TILE * grain.scale)} ${px(GRAIN_TILE * grain.scale)}`
  }
  values['--select-chevron'] = svgUrl(chevronSvg(colorCss(opaqueOver(flat(tokens.fg), windowColor))))

  // Regions: colour, then grain, tint and picture as matching layer lists.
  const layered: string[] = []
  for (const [name, region] of Object.entries(REGIONS) as [RegionName, (typeof REGIONS)[RegionName]][]) {
    const spec: SurfaceSpec | undefined = theme.surfaces[name]
    if (!spec) continue
    const color = regionColor[name]
    if (color) values[region.color] = colorCss(color)
    if (name === 'popover' && spec.blur !== undefined) values['--popover-blur'] = px(spec.blur)
    if (spec.grain === undefined && !spec.image) continue
    const amount = spec.grain ?? (region.grainByDefault ? grain.amount : 0)
    const layers: Layer[] = []
    if (amount > 0) {
      // The theme's own grain is referenced, not copied, so it switches off
      // with --glass-grain under reduced transparency.
      const image = amount === grain.amount ? 'var(--glass-grain)'
        : grain.texture ? textureImage(grain.texture, amount, options) : svgUrl(grainSvg(amount, theme.appearance))
      layers.push({ image, size: 'var(--grain-size)', position: '0% 0%', repeat: 'repeat' })
    }
    if (spec.image?.tint) layers.push(tintLayer(spec.image.tint))
    if (spec.image) layers.push(pictureLayer(spec.image, options))
    writeLayers(values, region.image, layers)
    layered.push(region.image)
  }

  // The window: transparent over vibrancy, or a colour, or a picture behind everything.
  const win = theme.window
  if (win.material !== 'vibrancy') values['--window-bg'] = colorCss(windowColor)
  if (win.material === 'image' && win.image) {
    const layers: Layer[] = []
    if (win.image.dim > 0) layers.push(tintLayer(withAlpha(windowColor, win.image.dim)))
    if (win.image.tint) layers.push(tintLayer(win.image.tint))
    layers.push(pictureLayer(win.image, options))
    writeLayers(values, 'window', layers)
    if (win.image.blur > 0) {
      values['--window-filter'] = `blur(${px(win.image.blur)})`
      // Blur pulls the edge in from transparent; start the layer off-screen.
      values['--window-bleed'] = px(-2 * win.image.blur)
    }
  }

  // Type.
  const fonts = theme.fonts
  if (fonts.ui?.family) values['--font-ui'] = families(fonts.ui.family, DEFAULT_UI_STACK)
  if (fonts.ui?.lineHeight !== undefined) values['--ui-line-height'] = num(fonts.ui.lineHeight)
  if (fonts.reading?.family) values['--font-reading'] = families(fonts.reading.family, DEFAULT_UI_STACK)
  if (fonts.reading?.lineHeight !== undefined) values['--reading-line-height'] = num(fonts.reading.lineHeight)
  if (fonts.heading?.family) values['--font-heading'] = families(fonts.heading.family, DEFAULT_UI_STACK)
  if (fonts.heading?.weight !== undefined) values['--heading-weight'] = String(fonts.heading.weight)
  if (fonts.heading?.letterSpacing !== undefined) values['--heading-letter-spacing'] = `${num(fonts.heading.letterSpacing)}em`
  if (fonts.code?.family) values['--font-mono'] = families(fonts.code.family, DEFAULT_MONO_STACK)
  if (fonts.brand?.family) values['--font-brand'] = families(fonts.brand.family, DEFAULT_UI_STACK)
  if (fonts.brand?.weight !== undefined) values['--brand-weight'] = String(fonts.brand.weight)
  if (fonts.brand?.letterSpacing !== undefined) values['--brand-letter-spacing'] = `${num(fonts.brand.letterSpacing)}em`

  // Reduced transparency (and increased contrast, as the stylesheet does it):
  // every translucent surface becomes what it would look like over the window,
  // and grain and pictures go.
  const reducedTransparency: Record<string, string> = {}
  for (const token of COLOR_TOKENS) {
    if (!SURFACE_TOKENS.has(token)) continue
    const own = theme.reducedTransparency[token]
    const color = flat(tokens[token])
    if (own) reducedTransparency[tokenProperty(token)] = paintCss(token, opaqueOver(flat(own), windowColor))
    else if (color.a < 1) reducedTransparency[tokenProperty(token)] = paintCss(token, composite(color, windowColor))
  }
  for (const [token, paint] of Object.entries(theme.reducedTransparency) as [ColorToken, Paint][]) {
    if (!SURFACE_TOKENS.has(token)) reducedTransparency[tokenProperty(token)] = paintCss(token, paint)
  }
  for (const [name, color] of Object.entries(regionColor) as [RegionName, Rgba][]) {
    if (color.a < 1) reducedTransparency[REGIONS[name].color] = colorCss(composite(color, windowColor))
  }
  reducedTransparency['--glass-grain'] = 'none'
  for (const prefix of layered) reducedTransparency[`--${prefix}-image`] = 'none'
  if (values['--window-image']) {
    reducedTransparency['--window-image'] = 'none'
    reducedTransparency['--window-filter'] = 'none'
  }

  const increased: Partial<Record<ColorToken, Paint>> = { ...deriveIncreasedContrast(tokens), ...theme.increasedContrast }
  const increasedContrast: Record<string, string> = {}
  for (const [token, paint] of Object.entries(increased) as [ColorToken, Paint][]) increasedContrast[tokenProperty(token)] = paintCss(token, paint)

  assertSafe(values)
  assertSafe(reducedTransparency)
  assertSafe(increasedContrast)

  const css = [
    `/* ${theme.name} - compiled by OpenCourse; a theme is values, never rules. */`,
    block(':root', values),
    `@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {\n${block(':root', reducedTransparency)}\n}`,
    `@media (prefers-contrast: more) {\n${block(':root', increasedContrast)}\n}`
  ].join('\n')

  return {
    css,
    appearance: theme.appearance,
    faces: fonts.faces.map((face) => ({ ...face })),
    logo: theme.logo ? options.url(theme.logo.mark) : null,
    native: { appearance: theme.appearance, vibrancy: win.material === 'vibrancy', background: colorCss(windowColor) },
    notes,
    values,
    reducedTransparency,
    increasedContrast
  }
}
