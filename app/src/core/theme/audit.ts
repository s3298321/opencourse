/**
 * Whether a theme can be read.
 *
 * Contrast is measured on the compiled values - what will actually be drawn -
 * with every translucent surface composited over the window colour. A poor
 * pairing is a warning on the theme's card, not a refusal: the learner chose
 * the theme, and View → Theme in the native menu is always readable.
 */
import { composite, contrast, parseColor, type Rgba } from './color'
import type { CompiledTheme } from './compile'
import { REGIONS, type RegionName } from './tokens'
import type { Theme, ThemeNote } from './types'

const BODY = 4.5
const QUIET = 3

const ratio = (value: number): string => `${Math.round(value * 10) / 10}:1`

export function auditTheme(theme: Theme, compiled: CompiledTheme): ThemeNote[] {
  const notes: ThemeNote[] = []
  const window = parseColor(compiled.native.background) ?? { r: 0, g: 0, b: 0, a: 1 }
  const value = (property: string): Rgba | null => parseColor(compiled.values[property] ?? '')
  const over = (color: Rgba | null, base: Rgba): Rgba | null => (color ? composite(color, base) : null)

  const bg = over(value('--bg'), window)!
  const fg = value('--fg')
  const muted = value('--muted')
  if (!fg) return notes

  const surfaces: Array<[string, Rgba | null]> = [
    ['the reading surface', bg],
    ['cards', over(value('--card'), bg)],
    ['code', over(value('--code-bg'), window)],
    ['the titlebar', over(value('--chrome'), window)],
    ['menus', over(value('--popover'), window)]
  ]
  for (const name of ['sidebar', 'list', 'sidechat'] as const) {
    const own = compiled.values[REGIONS[name].color]
    surfaces.push([name === 'list' ? 'the library and coach lists' : name === 'sidechat' ? 'the side chat' : 'the sidebar', over(parseColor(own ?? compiled.values['--glass'] ?? ''), window)])
  }

  for (const [label, surface] of surfaces) {
    if (!surface) continue
    const body = contrast(fg, surface)
    if (body < BODY) notes.push({ level: 'warning', message: `Text on ${label} reads at ${ratio(body)}; at least ${BODY}:1 is needed to read comfortably.` })
  }
  if (muted) {
    const quiet = contrast(composite(muted, bg), bg)
    if (quiet < QUIET) notes.push({ level: 'warning', message: `Secondary text on the reading surface reads at ${ratio(quiet)}; at least ${QUIET}:1 is needed.` })
  }
  const accent = value('--accent')
  const onAccent = value('--accent-fg')
  if (accent && onAccent) {
    const buttons = contrast(onAccent, composite(accent, bg))
    if (buttons < BODY) notes.push({ level: 'warning', message: `Button labels read at ${ratio(buttons)} on the accent colour; at least ${BODY}:1 is needed.` })
  }

  for (const name of Object.keys(REGIONS) as RegionName[]) {
    const picture = theme.surfaces[name]?.image
    if (picture && !picture.tint) notes.push({ level: 'info', message: `Contrast over the ${name} picture cannot be measured; a tint keeps text on it readable.` })
  }
  if (theme.window.image && compiled.native.vibrancy === false && theme.window.image.dim === 0) {
    notes.push({ level: 'info', message: 'The window picture shows through translucent surfaces at full strength; dim softens it.' })
  }
  return notes
}
