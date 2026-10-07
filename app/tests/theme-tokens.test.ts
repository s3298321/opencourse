/**
 * The contract between core/theme/tokens.ts and the stylesheet. A token a
 * theme can set but no rule reads is a setting that silently does nothing; a
 * token renamed in styles.css but not here is every theme quietly losing it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INHERITING_PROPERTIES, THEME_PROPERTIES } from '@core/theme/tokens'
import { STYLES, stylesheetBlocks } from './helpers/theme-css'

const css = readFileSync(STYLES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const workbench = readFileSync(join(__dirname, '..', 'src', 'renderer', 'workbench', 'theme.ts'), 'utf8')

describe('theme properties', () => {
  it('are each declared in :root, or deliberately left to inherit', () => {
    const { base } = stylesheetBlocks()
    const missing = [...THEME_PROPERTIES].filter((name) => !(name in base) && !INHERITING_PROPERTIES.has(name))
    expect(missing).toEqual([])
    const declaredAnyway = [...INHERITING_PROPERTIES].filter((name) => name in base)
    expect(declaredAnyway).toEqual([])
  })

  it('are each read by a rule, or by the editor and terminal', () => {
    const unread = [...THEME_PROPERTIES].filter((name) => !css.includes(`var(${name})`) && !workbench.includes(`'${name}'`))
    expect(unread).toEqual([])
  })

  it('are the only custom properties a region rule paints with', () => {
    // Every background declaration on a themed region goes through a token.
    for (const selector of ['.titlebar', '.sidebar', '.sidechat', '.content-glass', '.menu-panel, .search-panel']) {
      const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
      expect(rule, selector).not.toBeNull()
      const backgrounds = rule![1]!.split(';').filter((part) => /^\s*background(?:-color|-image)?\s*:/.test(part))
      expect(backgrounds.length, selector).toBeGreaterThan(0)
      for (const declaration of backgrounds) expect(declaration, selector).toMatch(/var\(--/)
    }
  })
})
