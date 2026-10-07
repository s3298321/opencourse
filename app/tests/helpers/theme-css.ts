/**
 * Just enough CSS reading to answer "what does this custom property resolve
 * to?" for styles.css and a compiled theme - the three :root blocks, var()
 * substitution, and a canonical form for colours and the SVGs behind url().
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { colorCss, parseColor } from '@core/theme/color'

export const STYLES = join(__dirname, '..', '..', 'src', 'renderer', 'styles.css')

export type Block = Record<string, string>

export function declarations(body: string): Block {
  const out: Block = {}
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const name = part.slice(0, colon).trim()
    if (name) out[name] = part.slice(colon + 1).trim()
  }
  return out
}

/** The default look: :root and the two accessibility :root blocks. */
export function stylesheetBlocks(css = readFileSync(STYLES, 'utf8')): { base: Block; reducedTransparency: Block; increasedContrast: Block } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const base = /(?:^|\n)\s*:root\s*\{([^}]*)\}/.exec(text)
  const rt = /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{\s*:root \{([^}]*)\}/.exec(text)
  const ic = /@media \(prefers-contrast: more\) \{\s*:root \{([^}]*)\}/.exec(text)
  if (!base || !rt || !ic) throw new Error('styles.css no longer has the :root blocks this test reads')
  return { base: declarations(base[1]!), reducedTransparency: declarations(rt[1]!), increasedContrast: declarations(ic[1]!) }
}

export function resolve(name: string, decls: Block, depth = 0): string {
  const value = decls[name]
  if (value === undefined || depth > 20) return 'UNSET'
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, inner: string) => resolve(inner, decls, depth + 1))
}

const normalizeSvg = (svg: string): string => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()

/** Same value, same string: colours canonical, SVG URLs by their content. */
export function canonical(value: string, assetDir = join(__dirname, '..', '..', 'src', 'renderer')): string {
  let out = value.trim().replace(/\s+/g, ' ')
  // Quoted first: a data URL's SVG has its own url(#grain), whose ) ends an unquoted match.
  out = out.replace(/url\("([^"]*)"\)|url\('([^']*)'\)|url\(([^)"']*)\)/g, (_match, a?: string, b?: string, c?: string) => {
    const url = a ?? b ?? c ?? ''
    if (url.startsWith('data:image/svg+xml,')) return `svg(${normalizeSvg(decodeURIComponent(url.slice('data:image/svg+xml,'.length)))})`
    if (url.startsWith('./')) return `svg(${normalizeSvg(readFileSync(join(assetDir, url), 'utf8'))})`
    return `url(${url})`
  })
  if (!out.startsWith('svg(')) {
    out = out.replace(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g, (color) => {
      const parsed = parseColor(color)
      return parsed ? colorCss(parsed) : color
    })
  }
  return out
}

/** Every value the window would see under some media condition, in cascade order. */
export function effective(blocks: Block[]): Block {
  return Object.assign({}, ...blocks) as Block
}
