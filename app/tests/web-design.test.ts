/**
 * The web - the catalog server's web app and opencourse.dev - wears the app's
 * own look through design/tokens.css. These tests keep it the app's look:
 * every token the two stylesheets share resolves to the same value under every
 * accessibility preference, and the web's grain and mark are the app's own
 * files rather than copies that drifted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonical, effective, resolve, stylesheetBlocks, type Block } from './helpers/theme-css'

const DESIGN = join(__dirname, '..', '..', 'design')
const app = stylesheetBlocks()
const web = stylesheetBlocks(readFileSync(join(DESIGN, 'tokens.css'), 'utf8'))

/** The tokens the web's primitives are built from; renaming one away must be deliberate. */
const REQUIRED = ['--fg', '--muted', '--bg', '--card', '--raised', '--accent', '--accent-fg', '--border', '--selected',
  '--selected-edge', '--ok', '--err', '--chip-bg', '--chip-fg', '--ok-bg', '--ok-border', '--err-bg', '--err-border',
  '--accent-ring', '--code-bg', '--popover', '--hover-ring', '--shadow-rgb', '--ease', '--font-ui', '--font-mono',
  '--brand-weight', '--brand-letter-spacing', '--scrollbar', '--scrollbar-hover']

function differences(appBlock: Block, webBlock: Block, condition: string): string[] {
  const out: string[] = []
  for (const name of Object.keys(webBlock)) {
    if (!name.startsWith('--') || !(name in appBlock)) continue
    const a = canonical(resolve(name, appBlock)), b = canonical(resolve(name, webBlock))
    if (a !== b) out.push(`${condition} ${name}: app ${a} / web ${b}`)
  }
  return out
}

describe('design/tokens.css', () => {
  it('declares every token the web primitives need, under the app\'s names', () => {
    expect(REQUIRED.filter((name) => !(name in web.base) || !(name in app.base))).toEqual([])
  })

  it('agrees with the app\'s stylesheet on every shared token, under every accessibility preference', () => {
    const conditions = {
      plain: [[app.base], [web.base]],
      reducedTransparency: [[app.base, app.reducedTransparency], [web.base, web.reducedTransparency]],
      increasedContrast: [[app.base, app.reducedTransparency, app.increasedContrast], [web.base, web.reducedTransparency, web.increasedContrast]]
    } as const
    const found: string[] = []
    for (const [condition, [appBlocks, webBlocks]] of Object.entries(conditions)) {
      found.push(...differences(effective([...appBlocks]), effective([...webBlocks]), condition))
    }
    expect(found).toEqual([])
  })

  it('would notice a shared token drifting', () => {
    expect(differences(app.base, { ...web.base, '--card': '#212125' }, 'plain')).toHaveLength(1)
  })
})

describe('design/assets', () => {
  const normalize = (svg: string): string => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()

  it('uses the app\'s grain, not a copy that drifted', () => {
    const appGrain = readFileSync(join(__dirname, '..', 'src', 'renderer', 'assets', 'glass-grain.svg'), 'utf8')
    expect(normalize(readFileSync(join(DESIGN, 'assets', 'grain.svg'), 'utf8'))).toBe(normalize(appGrain))
  })

  it('uses the app\'s mark, exported from the same master (npm run build:icons)', () => {
    const mark = readFileSync(join(__dirname, '..', 'resources', 'branding', 'mark.png'))
    expect(readFileSync(join(DESIGN, 'assets', 'brand', 'mark-128.png')).equals(mark)).toBe(true)
  })
})
