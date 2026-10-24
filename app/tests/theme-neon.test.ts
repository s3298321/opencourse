import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import schema from '@core/theme/theme-schema.json'
import { auditTheme } from '@core/theme/audit'
import { composite, contrast, parseColor } from '@core/theme/color'
import { compileTheme, THEME_URL_PREFIX } from '@core/theme/compile'
import { readThemeDirectory } from '../src/main/theme-files'

const directory = resolve(import.meta.dirname, '../resources/themes/neon-afterhours')
const read = readThemeDirectory(directory)
if ('error' in read) throw new Error(read.error)
const compiled = compileTheme(read.theme, { assets: read.assets, url: path => `${THEME_URL_PREFIX}builtin:neon-afterhours/${path}` })

describe('Neon Afterhours portable theme', () => {
  it('validates the real bundle without dropped fields or contrast warnings', () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
    expect(validate(JSON.parse(readFileSync(resolve(directory, 'theme.json'), 'utf8'))), JSON.stringify(validate.errors)).toBe(true)
    expect(read.notes).toEqual([])
    expect(compiled.notes).toEqual([])
    expect(auditTheme(read.theme, compiled)).toEqual([])
  })

  it('keeps primary and secondary text readable, including with accessibility overrides', () => {
    for (const overrides of [{}, compiled.reducedTransparency, { ...compiled.reducedTransparency, ...compiled.increasedContrast }]) {
      const values = { ...compiled.values, ...overrides }
      const window = parseColor(compiled.native.background)!
      for (const token of ['--bg', '--card', '--code-bg', '--chrome', '--glass', '--popover', '--bubble', '--composer-bg', '--chip-bg']) {
        const surface = composite(parseColor(values[token])!, window)
        for (const text of ['--fg', '--muted']) {
          expect(contrast(parseColor(values[text])!, surface), `${text} on ${token}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(contrast(parseColor(values['--accent-fg'])!, parseColor(values['--accent'])!)).toBeGreaterThanOrEqual(4.5)
    }
    expect(compiled.values['--bg']).toBe('#14101f')
    expect(compiled.values['--code-bg']).toBe('#0e0c18')
    expect(compiled.reducedTransparency['--window-image']).toBe('none')
    expect(compiled.reducedTransparency['--sidebar-image']).toBe('none')
  })
})
