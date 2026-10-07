/**
 * The app's grain, at any strength.
 *
 * Exactly the filter in `renderer/assets/glass-grain.svg` with the noise
 * opacity as a parameter: at 0.12 it is that file, byte for byte apart from
 * the comment (tests/theme-default.test.ts reads both). A theme's grain goes in
 * as a `data:` URL, which `img-src` already allows, so the CSP does not move.
 */

/** The tile the noise is drawn on, before a theme's `grain.scale`. */
export const GRAIN_TILE = 160

const number = (value: number): string => String(Math.round(value * 1000) / 1000)

export function grainSvg(amount: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GRAIN_TILE}" height="${GRAIN_TILE}" viewBox="0 0 ${GRAIN_TILE} ${GRAIN_TILE}">`,
    `  <filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="19" stitchTiles="stitch"/>`,
    `    <feColorMatrix type="saturate" values="0"/>`,
    `    <feComponentTransfer>`,
    `      <feFuncA type="linear" slope="${number(amount)}"/>`,
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
