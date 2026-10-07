/**
 * What a theme may change, by name.
 *
 * This is the whole contract between a theme and the stylesheet. A theme
 * compiles to values for these custom properties and nothing else - never a
 * selector, never a property that is not a `--token` - so it can change how a
 * surface looks but has no way to hide a control or move one. `styles.css`
 * declares every one of them in `:root` (or reads it with the absence
 * meaning "inherit"), which `tests/theme-tokens.test.ts` checks, so a token
 * cannot be renamed out from under the themes that set it.
 */

/** Colour tokens a theme may set through `tokens`. Always emitted in full. */
export const COLOR_TOKENS = [
  'fg', 'muted', 'bg', 'card', 'accent', 'accent-fg', 'border',
  'selected', 'selected-edge', 'check-accent', 'ok', 'err', 'err-fg',
  'chip-bg', 'chip-fg', 'ok-bg', 'ok-border', 'err-bg', 'err-border',
  'accent-ring', 'code-bg', 'bubble', 'bubble-border', 'composer-bg',
  'scrollbar', 'scrollbar-hover', 'chrome', 'glass', 'popover', 'overlay',
  'shadow', 'hover-ring', 'editor-active-line', 'terminal-selection'
] as const
export type ColorToken = typeof COLOR_TOKENS[number]

export function isColorToken(value: unknown): value is ColorToken {
  return typeof value === 'string' && (COLOR_TOKENS as readonly string[]).includes(value)
}

/** `selected` is the one token that may be a two-stop gradient. */
export const GRADIENT_TOKENS: ReadonlySet<ColorToken> = new Set(['selected'])

/** Written as `--shadow-rgb: r g b`, because rules supply their own alpha. */
export const TRIPLET_TOKENS: ReadonlySet<ColorToken> = new Set(['shadow'])

/** The CSS custom property a colour token is written to. */
export function tokenProperty(token: ColorToken): string {
  return TRIPLET_TOKENS.has(token) ? `--${token}-rgb` : `--${token}`
}

/**
 * Surfaces that are painted, as opposed to overlays (rings, scrollbars) that
 * are meant to be seen through. Under reduced transparency these are made
 * opaque by compositing them over the window colour.
 */
export const SURFACE_TOKENS: ReadonlySet<ColorToken> = new Set([
  'bg', 'card', 'chip-bg', 'code-bg', 'bubble', 'composer-bg', 'chrome', 'glass', 'popover'
])

/**
 * Reading and editing surfaces. CLAUDE.md: keep them opaque. A theme asking
 * for less is composited over the window colour and told so.
 */
export const OPAQUE_TOKENS: ReadonlySet<ColorToken> = new Set(['bg', 'code-bg'])

/**
 * A region is an area of the window with its own background rule: a colour,
 * then up to three image layers (grain, tint, picture) read from
 * `--<image>-image`, `-image-size`, `-image-position` and `-image-repeat`.
 */
export interface Region {
  /** The colour property this region is painted with. */
  color: string
  /** Prefix of its image properties. */
  image: string
  /** Whether a theme may put a picture here, or only grain. */
  pictures: boolean
  /** Whether the region carries the app's grain when the theme says nothing. */
  grainByDefault: boolean
  /** Must stay opaque (reading surfaces). */
  opaque: boolean
}

export const REGIONS = {
  titlebar: { color: '--chrome', image: 'titlebar', pictures: true, grainByDefault: false, opaque: false },
  sidebar: { color: '--sidebar-bg', image: 'sidebar', pictures: true, grainByDefault: true, opaque: false },
  list: { color: '--list-bg', image: 'list', pictures: true, grainByDefault: true, opaque: false },
  sidechat: { color: '--sidechat-bg', image: 'sidechat', pictures: true, grainByDefault: true, opaque: false },
  popover: { color: '--popover', image: 'popover', pictures: false, grainByDefault: true, opaque: false },
  reading: { color: '--bg', image: 'reading', pictures: false, grainByDefault: false, opaque: true }
} as const satisfies Record<string, Region>
export type RegionName = keyof typeof REGIONS

/** Surfaces that only take a colour, mapped to the token they set. */
export const FILLS = {
  code: 'code-bg',
  card: 'card',
  chip: 'chip-bg',
  bubble: 'bubble',
  composer: 'composer-bg'
} as const satisfies Record<string, ColorToken>
export type FillName = keyof typeof FILLS

export type SurfaceName = RegionName | FillName
export const SURFACE_NAMES = [...Object.keys(REGIONS), ...Object.keys(FILLS)] as SurfaceName[]

/** Font slots and the properties each one writes. */
export const FONT_SLOTS = ['ui', 'reading', 'heading', 'code', 'brand'] as const
export type FontSlotName = typeof FONT_SLOTS[number]

/**
 * Every custom property a compiled theme may contain. `compile.ts` refuses to
 * write anything else, and the token test reads this list against the
 * stylesheet.
 */
export const THEME_PROPERTIES: ReadonlySet<string> = new Set([
  ...COLOR_TOKENS.map(tokenProperty),
  ...Object.values(REGIONS).flatMap((region) => [
    region.color,
    `--${region.image}-image`, `--${region.image}-image-size`,
    `--${region.image}-image-position`, `--${region.image}-image-repeat`
  ]),
  '--window-bg', '--window-image', '--window-image-size', '--window-image-position',
  '--window-image-repeat', '--window-filter', '--window-bleed',
  '--glass-grain', '--grain-size', '--popover-blur',
  '--font-ui', '--ui-size', '--ui-line-height',
  '--font-reading', '--reading-size', '--reading-line-height',
  '--font-heading', '--heading-weight', '--heading-letter-spacing',
  '--font-mono', '--code-scale',
  '--font-brand', '--brand-weight', '--brand-letter-spacing',
  '--color-scheme', '--select-chevron'
])

/**
 * Read with `var()` and deliberately *not* declared in `:root`: an undeclared
 * custom property makes the declaration invalid at computed-value time, and
 * font-family, line-height and letter-spacing then inherit - which is exactly
 * "headings use whatever font surrounds them unless a theme says otherwise".
 */
export const INHERITING_PROPERTIES: ReadonlySet<string> = new Set([
  '--font-reading', '--reading-line-height', '--font-heading', '--heading-letter-spacing', '--font-brand'
])

/** The app's own stacks, appended after a theme's families so a missing font degrades. */
export const DEFAULT_UI_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
export const DEFAULT_MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace'
