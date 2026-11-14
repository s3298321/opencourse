/** A theme after normalize.ts: every value parsed, clamped and checked. */
import type { Rgba } from './color'
import type { ColorToken, FontSlotName, FillName, RegionName } from './tokens'

export type Appearance = 'dark' | 'light'

/** A colour, or - for `selected` only - a two-stop gradient. */
export type Paint = Rgba | { from: Rgba; to: Rgba }

export const FITS = ['cover', 'contain', 'tile', 'stretch'] as const
export type Fit = typeof FITS[number]

export const POSITIONS = [
  'center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'
] as const
export type Position = typeof POSITIONS[number]

export interface Picture {
  /** A path inside the theme archive, already checked to be an image. */
  src: string
  fit: Fit
  position: Position
  /** For `tile`: the picture's own size times this. */
  scale: number
  /** Painted over the picture, under the grain. */
  tint?: Rgba
}

export interface WindowSpec {
  material: 'vibrancy' | 'solid' | 'image'
  color?: Rgba
  image?: Picture & { blur: number; dim: number }
}

export interface GrainSpec {
  /** Opacity of the noise, 0-0.4; 0.12 when a theme gives none. The app's own is 0.2. */
  amount: number
  /** Tile scale, 0.5-3: larger is coarser. */
  scale: number
  /** A picture to tile instead of the generated noise. */
  texture?: string
}

export interface SurfaceSpec {
  color?: Rgba
  /** Replaces the colour's alpha - including a colour the theme left to the palette. */
  opacity?: number
  /** Grain amount for this surface alone; 0 turns it off. */
  grain?: number
  image?: Picture
  /** Popover only: the backdrop blur, in px. */
  blur?: number
}

export interface FontFaceSpec {
  family: string
  src: string
  /** `400`, or a variable font's range `100 900`. */
  weight: string
  style: 'normal' | 'italic'
}

export interface FontSlot {
  family?: string[]
  weight?: number
  lineHeight?: number
  /** In em. */
  letterSpacing?: number
}

export interface Theme {
  format: 1
  id: string
  name: string
  version?: string
  author?: string
  description?: string
  appearance: Appearance
  preview?: string
  palette: { background: Rgba; text: Rgba; accent: Rgba; muted?: Rgba; success?: Rgba; danger?: Rgba }
  tokens: Partial<Record<ColorToken, Paint>>
  reducedTransparency: Partial<Record<ColorToken, Paint>>
  increasedContrast: Partial<Record<ColorToken, Paint>>
  window: WindowSpec
  grain: GrainSpec
  surfaces: Partial<Record<RegionName | FillName, SurfaceSpec>>
  fonts: { faces: FontFaceSpec[] } & Partial<Record<FontSlotName, FontSlot>>
  logo?: { mark: string }
}

/** Something about a theme worth telling its user: a dropped field, a hard-to-read pairing. */
export interface ThemeNote {
  level: 'warning' | 'info'
  message: string
}
