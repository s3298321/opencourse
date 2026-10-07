/**
 * A whole palette from a few colours.
 *
 * Most tokens are a background moved some way toward the text colour; the
 * distances are measured off the app's own palette (card sits 4% of the way
 * from background to text, borders 17%, muted text 71%…), so three colours give
 * a theme with the same hierarchy as the default. A theme's `tokens` then
 * override any of it exactly.
 */
import { bestOn, composite, contrast, mix, parseColor, withAlpha, type Rgba } from './color'
import { COLOR_TOKENS, type ColorToken } from './tokens'
import type { Appearance, Paint, Theme } from './types'

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/** Status colours when the palette names none, per appearance. */
const STATUS: Record<Appearance, { ok: Rgba; err: Rgba }> = {
  dark: { ok: parseColor('#78bd91')!, err: parseColor('#ee9292')! },
  light: { ok: parseColor('#1f7a43')!, err: parseColor('#b42318')! }
}

export function derivePalette(theme: Pick<Theme, 'appearance' | 'palette'>): Record<ColorToken, Paint> {
  const { appearance } = theme
  const bg = theme.palette.background.a < 1 ? composite(theme.palette.background, BLACK) : theme.palette.background
  const fg = theme.palette.text
  const accent = theme.palette.accent
  const toward = (t: number): Rgba => mix(bg, { ...fg, a: 1 }, t)
  const ok = theme.palette.success ?? STATUS[appearance].ok
  const err = theme.palette.danger ?? STATUS[appearance].err
  const card = toward(0.04)
  // Black glass over a dark window, white glass over a light one.
  const tint = appearance === 'dark' ? BLACK : WHITE
  const shade = (color: Rgba): Rgba => mix(bg, color, 0.1)
  const edge = (color: Rgba): Rgba => mix(bg, color, 0.25)
  const onAccent = bestOn(accent, [card, fg])
  const accentFg = contrast(onAccent, accent) >= 4.5 ? onAccent : bestOn(accent, [BLACK, WHITE])

  const tokens: Record<ColorToken, Paint> = {
    fg,
    muted: theme.palette.muted ?? toward(0.712),
    bg,
    card,
    accent,
    'accent-fg': accentFg,
    border: toward(0.167),
    selected: { from: toward(0.162), to: toward(0.101) },
    'selected-edge': withAlpha(fg, 0.1),
    'check-accent': toward(0.313),
    ok,
    err,
    'err-fg': bestOn(err, [WHITE, BLACK]),
    'chip-bg': toward(0.096),
    'chip-fg': toward(0.874),
    'ok-bg': shade(ok),
    'ok-border': edge(ok),
    'err-bg': shade(err),
    'err-border': edge(err),
    'accent-ring': withAlpha(accent, 0.15),
    'code-bg': toward(0.025),
    bubble: toward(0.111),
    'bubble-border': toward(0.212),
    'composer-bg': toward(0.081),
    scrollbar: withAlpha(fg, 0.18),
    'scrollbar-hover': withAlpha(fg, 0.36),
    chrome: withAlpha(tint, appearance === 'dark' ? 0.52 : 0.6),
    glass: withAlpha(tint, appearance === 'dark' ? 0.25 : 0.35),
    popover: withAlpha(toward(0.061), 0.94),
    overlay: withAlpha(BLACK, appearance === 'dark' ? 0.35 : 0.2),
    shadow: BLACK,
    'hover-ring': withAlpha(fg, 0.12),
    'editor-active-line': appearance === 'dark' ? withAlpha(WHITE, 0.04) : withAlpha(BLACK, 0.04),
    'terminal-selection': withAlpha(accent, 0.18)
  }
  // Every token, always: a compiled theme is complete, so nothing it leaves out
  // can fall through to the default's dark values under a light theme.
  for (const token of COLOR_TOKENS) if (!(token in tokens)) throw new Error(`derivePalette is missing ${token}`)
  return tokens
}

/** Stronger edges and quieter-text-made-louder, for `prefers-contrast: more`. */
export function deriveIncreasedContrast(tokens: Record<ColorToken, Paint>): Partial<Record<ColorToken, Paint>> {
  const bg = tokens.bg as Rgba
  const fg = tokens.fg as Rgba
  return {
    border: mix(bg, { ...fg, a: 1 }, 0.465),
    muted: mix(bg, { ...fg, a: 1 }, 0.874),
    'selected-edge': withAlpha(fg, 0.55)
  }
}
