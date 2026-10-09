import type { Appearance } from './types'

/**
 * The app's grain, at any strength.
 *
 * Exactly the filter in `renderer/assets/glass-grain.svg` with the strength as
 * a parameter: at 0.2 on a dark theme it is that file, byte for byte apart from
 * the comment (tests/theme-default.test.ts reads both). A theme's grain goes in
 * as a `data:` URL, which `img-src` already allows, so the CSP does not move.
 *
 * Two-tone on purpose. The noise used to be mid-grey specks, and grey laid over
 * dark glass lifts it and drains the colour of whatever shows through - the
 * glass read as grey rather than black. Now the noise's own brightness picks a
 * black or a white speck, and its distance from the middle picks how strong.
 * White on a dark surface shows far more than black does, so the two are
 * weighted against each other and the surface keeps its colour; a light theme
 * mirrors the weights.
 */

/** The tile the noise is drawn on, before a theme's `grain.scale`. */
export const GRAIN_TILE = 160

/** How much of `amount` the specks that oppose the surface take, and the specks that match it. */
const OPPOSING = 0.45
const MATCHING = 1.8

const number = (value: number): string => String(Math.round(value * 1000) / 1000)

export function grainSvg(amount: number, appearance: Appearance = 'dark'): string {
  const dark = amount * (appearance === 'dark' ? MATCHING : OPPOSING)
  const light = amount * (appearance === 'dark' ? OPPOSING : MATCHING)
  // A table over the noise's brightness: strongest at either end, nothing in the middle.
  const alpha = [dark, dark, dark / 2, 0, light / 2, light, light].map(number).join(' ')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GRAIN_TILE}" height="${GRAIN_TILE}" viewBox="0 0 ${GRAIN_TILE} ${GRAIN_TILE}">`,
    `  <filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `    <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="2" seed="19" stitchTiles="stitch"/>`,
    `    <feColorMatrix type="matrix" values="0.333 0.333 0.333 0 0  0.333 0.333 0.333 0 0  0.333 0.333 0.333 0 0  0.333 0.333 0.333 0 0"/>`,
    `    <feComponentTransfer>`,
    `      <feFuncR type="discrete" tableValues="0 1"/>`,
    `      <feFuncG type="discrete" tableValues="0 1"/>`,
    `      <feFuncB type="discrete" tableValues="0 1"/>`,
    `      <feFuncA type="table" tableValues="${alpha}"/>`,
    `    </feComponentTransfer>`,
    `  </filter>`,
    `  <rect width="${GRAIN_TILE}" height="${GRAIN_TILE}" filter="url(#grain)"/>`,
    `</svg>`
  ].join('\n')
}

/** `url("data:…")` - percent-encoded, so nothing in it can close the quote. */
export function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** The select chevron, stroked in the theme's text colour. */
export function chevronSvg(stroke: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m2 4 4 4 4-4" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}
