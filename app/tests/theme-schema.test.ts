/**
 * theme-schema.json, docs/theme-format.md and core/theme describe one format.
 * The course format's rule holds here too - they must not drift - and these
 * tests are what enforce it. Both shipped themes are read the way the app reads
 * them and validated the way an author's editor would.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import schema from '../src/core/theme/theme-schema.json'
import { THEME_KEYS, THEME_SCHEMA_ID } from '@core/theme/normalize'
import { COLOR_TOKENS, FONT_SLOTS, SURFACE_NAMES } from '@core/theme/tokens'
import { compileTheme, THEME_URL_PREFIX } from '@core/theme/compile'
import { auditTheme } from '@core/theme/audit'
import { readThemeDirectory } from '../src/main/theme-files'

const docs = join(__dirname, '..', '..', 'docs')
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
const doc = readFileSync(join(docs, 'theme-format.md'), 'utf8')

describe('theme schema', () => {
  it('is the format the app reads', () => {
    expect(schema.$id).toBe(THEME_SCHEMA_ID)
    expect(Object.keys(schema.properties).sort()).toEqual([...THEME_KEYS].sort())
    expect(Object.keys(schema.properties.tokens.properties).sort()).toEqual([...COLOR_TOKENS].sort())
    expect(Object.keys(schema.properties.surfaces.properties).sort()).toEqual([...SURFACE_NAMES].sort())
    expect(Object.keys(schema.properties.fonts.properties).filter((k) => k !== 'faces').sort()).toEqual([...FONT_SLOTS].sort())
  })

  it('refuses paths that leave the archive', () => {
    const base = JSON.parse(readFileSync(join(docs, 'default-theme', 'theme.json'), 'utf8'))
    for (const mark of ['../x.png', '/abs.png', 'a/../b.png', 'x.js', 'a\\\\b.png']) {
      expect(validate({ ...base, logo: { mark } }), mark).toBe(false)
    }
  })
})

describe('docs/theme-format.md', () => {
  it('documents every token, surface and font slot', () => {
    const missing = [...COLOR_TOKENS, ...SURFACE_NAMES, ...FONT_SLOTS].filter((name) => !doc.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })
})

for (const name of ['default-theme', 'example-theme']) {
  describe(`docs/${name}`, () => {
    const dir = join(docs, name)
    it('validates against the schema', () => {
      const valid = validate(JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8')))
      expect(validate.errors ?? []).toEqual([])
      expect(valid).toBe(true)
    })
    it('reads without notes and passes its own contrast audit', () => {
      const read = readThemeDirectory(dir)
      if ('error' in read) throw new Error(read.error)
      expect(read.notes).toEqual([])
      const compiled = compileTheme(read.theme, { url: (path) => `${THEME_URL_PREFIX}x/${path}`, assets: read.assets })
      expect(compiled.notes).toEqual([])
      expect(auditTheme(read.theme, compiled)).toEqual([])
    })
  })
}
