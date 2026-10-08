/**
 * The default look is the absence of a theme - styles.css :root - and it is
 * also exported as a theme, docs/default-theme, for authors to start from.
 * These tests are what keep the two the same thing: apply the exported theme
 * and every theme property resolves to exactly what the stylesheet alone
 * gives, with and without the accessibility preferences.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileTheme, THEME_URL_PREFIX } from '@core/theme/compile'
import { auditTheme } from '@core/theme/audit'
import { grainSvg } from '@core/theme/grain'
import { THEME_PROPERTIES } from '@core/theme/tokens'
import { readThemeDirectory } from '../src/main/theme-files'
import { canonical, effective, resolve, stylesheetBlocks } from './helpers/theme-css'

const DEFAULT_THEME = join(__dirname, '..', '..', 'docs', 'default-theme')

function load() {
  const read = readThemeDirectory(DEFAULT_THEME)
  if ('error' in read) throw new Error(read.error)
  return read
}

describe('docs/default-theme', () => {
  it('reads without a single note', () => {
    expect(load().notes).toEqual([])
  })

  it('compiles to exactly the stylesheet\'s own values, under every accessibility preference', () => {
    const { theme, assets } = load()
    const compiled = compileTheme(theme, { url: (path) => `${THEME_URL_PREFIX}default/${path}`, assets })
    const css = stylesheetBlocks()
    const conditions = {
      plain: { stylesheet: [css.base], theme: [compiled.values] },
      reducedTransparency: { stylesheet: [css.base, css.reducedTransparency], theme: [compiled.values, compiled.reducedTransparency] },
      increasedContrast: {
        stylesheet: [css.base, css.reducedTransparency, css.increasedContrast],
        theme: [compiled.values, compiled.reducedTransparency, compiled.increasedContrast]
      }
    }
    for (const [condition, blocks] of Object.entries(conditions)) {
      const alone = effective(blocks.stylesheet)
      // The theme's sheet comes after styles.css, so it wins where both say something.
      const themed = effective([...blocks.stylesheet, ...blocks.theme])
      const differences: string[] = []
      for (const property of THEME_PROPERTIES) {
        const a = canonical(resolve(property, alone))
        const b = canonical(resolve(property, themed))
        if (a !== b) differences.push(`${condition} ${property}: stylesheet ${a.slice(0, 90)} / theme ${b.slice(0, 90)}`)
      }
      expect(differences).toEqual([])
    }
  })

  it('would notice a single token drifting', () => {
    const { theme, assets } = load()
    const drifted = compileTheme({ ...theme, tokens: { ...theme.tokens, card: { r: 33, g: 32, b: 36, a: 1 } } }, { url: (path) => path, assets })
    const css = stylesheetBlocks()
    expect(canonical(resolve('--card', effective([css.base, drifted.values])))).not.toBe(canonical(resolve('--card', css.base)))
  })

  it('carries the app\'s own mark, byte for byte', () => {
    const exported = readFileSync(join(DEFAULT_THEME, 'images', 'mark.png'))
    const bundled = readFileSync(join(__dirname, '..', 'resources', 'branding', 'mark.png'))
    expect(exported.equals(bundled)).toBe(true)
  })

  it('generates the same grain the stylesheet ships as a file', () => {
    const file = readFileSync(join(__dirname, '..', 'src', 'renderer', 'assets', 'glass-grain.svg'), 'utf8')
    const strip = (svg: string): string => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim()
    expect(strip(grainSvg(0.2))).toBe(strip(file))
  })

  it('passes its own contrast audit', () => {
    const { theme, assets } = load()
    const compiled = compileTheme(theme, { url: (path) => `${THEME_URL_PREFIX}default/${path}`, assets })
    expect(auditTheme(theme, compiled).filter((note) => note.level === 'warning')).toEqual([])
    expect(compiled.native).toEqual({ appearance: 'dark', vibrancy: true, background: '#111110' })
  })
})
