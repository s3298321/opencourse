import { describe, expect, it } from 'vitest'
import { compiledWhiteTheme, whiteTheme } from '@core/theme/builtin'
import { auditTheme } from '@core/theme/audit'
import { composite, contrast, parseColor } from '@core/theme/color'
import { normalizeTheme } from '@core/theme/normalize'
import white from '@core/theme/white.json'

describe('built-in White palette', () => {
  it('normalizes without notes and keeps the app typography and logo', () => {
    const read = normalizeTheme(white, new Map())
    expect('error' in read).toBe(false)
    if ('error' in read) throw new Error(read.error)
    expect(read.notes).toEqual([])
    expect(compiledWhiteTheme.notes).toEqual([])
    expect(compiledWhiteTheme.logo).toBeNull()
    expect(compiledWhiteTheme.faces).toEqual([])
    expect(compiledWhiteTheme.values).toMatchObject({
      '--bg': '#ffffff', '--color-scheme': 'light',
      '--ui-line-height': '1.55', '--heading-weight': '700',
      '--brand-weight': '600', '--brand-letter-spacing': '-0.025em'
    })
  })

  it('passes the contrast audit and keeps text readable with accessibility preferences', () => {
    expect(auditTheme(whiteTheme, compiledWhiteTheme)).toEqual([])
    for (const overrides of [{}, compiledWhiteTheme.reducedTransparency, {
      ...compiledWhiteTheme.reducedTransparency, ...compiledWhiteTheme.increasedContrast
    }]) {
      const values = { ...compiledWhiteTheme.values, ...overrides }
      const window = parseColor(compiledWhiteTheme.native.background)!
      const fg = parseColor(values['--fg'])!
      for (const token of ['--bg', '--card', '--code-bg', '--chrome', '--glass', '--popover', '--bubble', '--composer-bg']) {
        const surface = composite(parseColor(values[token])!, window)
        expect(contrast(fg, surface), token).toBeGreaterThanOrEqual(4.5)
        expect(contrast(parseColor(values['--muted'])!, surface), `${token} secondary text`).toBeGreaterThanOrEqual(4.5)
      }
      for (const state of ['ok', 'err']) {
        expect(contrast(parseColor(values[`--${state}`])!, parseColor(values[`--${state}-bg`])!)).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(compiledWhiteTheme.reducedTransparency['--glass-grain']).toBe('none')
  })
})
