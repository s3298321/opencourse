/**
 * A theme changes how the app looks and nothing else. These tests try to make
 * one do more - break out of a declaration, aim a URL off the archive, name a
 * selector, make a reading surface see-through - and check what it degrades to.
 */
import { describe, expect, it } from 'vitest'
import { compileTheme, THEME_URL_PREFIX, type CompiledTheme } from '@core/theme/compile'
import { normalizeTheme } from '@core/theme/normalize'
import { auditTheme } from '@core/theme/audit'
import { COLOR_TOKENS, THEME_PROPERTIES, tokenProperty } from '@core/theme/tokens'
import { contrast, parseColor } from '@core/theme/color'
import type { ThemeAsset } from '@core/theme/assets'
import type { Theme, ThemeNote } from '@core/theme/types'

const assets = new Map<string, ThemeAsset>([
  ['images/desk.jpg', { kind: 'image', mime: 'image/jpeg', width: 1600, height: 900 }],
  ['images/linen.png', { kind: 'image', mime: 'image/png', width: 128, height: 96 }],
  ['images/mark.svg', { kind: 'image', mime: 'image/svg+xml', width: null, height: null }],
  ['fonts/Literata.woff2', { kind: 'font', mime: 'font/woff2' }]
])

const base = { format: 1, id: 'paper-night', name: 'Paper Night', appearance: 'dark', palette: { background: '#1b1a17', text: '#e8e2d4', accent: '#d9a441' } }

function read(raw: Record<string, unknown>): { theme: Theme; notes: ThemeNote[] } {
  const result = normalizeTheme({ ...base, ...raw }, assets)
  if ('error' in result) throw new Error(result.error)
  return result
}

function compile(raw: Record<string, unknown>): CompiledTheme & { readNotes: ThemeNote[] } {
  const { theme, notes } = read(raw)
  return { ...compileTheme(theme, { url: (path) => `${THEME_URL_PREFIX}abc/${path}`, assets }), readNotes: notes }
}

/**
 * Every declaration in the compiled stylesheet, with the selector it sits
 * under. Read line by line - the compiler writes one declaration per line, and
 * anything else on a line is something it should not have written.
 */
function declarationsOf(css: string): Array<{ selector: string; property: string }> {
  const out: Array<{ selector: string; property: string }> = []
  let selector = ''
  for (const raw of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const line = raw.trim()
    if (!line || line === '}' || line.startsWith('@media')) continue
    if (line.endsWith('{')) { selector = line.slice(0, -1).trim(); continue }
    const match = /^(--[a-z0-9-]+): (.+);$/.exec(line)
    if (!match) throw new Error(`unexpected line in compiled theme: ${line}`)
    out.push({ selector, property: match[1]! })
  }
  return out
}

/** A comma list split at depth 0, so rgba(…) inside a gradient stays whole. */
function splitLayers(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(value.slice(start).trim())
  return parts
}

describe('normalizeTheme', () => {
  it('refuses only what is not a theme', () => {
    expect(normalizeTheme('nope', assets)).toEqual({ error: expect.stringMatching(/not a JSON object/) })
    expect(normalizeTheme({ ...base, format: undefined }, assets)).toEqual({ error: expect.stringMatching(/no "format"/) })
    expect(normalizeTheme({ ...base, format: 2 }, assets)).toEqual({ error: expect.stringMatching(/newer OpenCourse/) })
    expect(normalizeTheme({ ...base, id: 'Not A Slug' }, assets)).toEqual({ error: expect.stringMatching(/"id"/) })
    expect(normalizeTheme({ ...base, name: '  ' }, assets)).toEqual({ error: expect.stringMatching(/"name"/) })
  })

  it('drops a bad field with a note and keeps the rest', () => {
    const { theme, notes } = read({
      tokens: { card: 'red;}body{display:none', border: '#333', display: 'none' },
      grain: { amount: 5 },
      surfaces: { body: { color: '#000' }, sidebar: { color: 'url(http://x)' } },
      unknownThing: true
    })
    expect(theme.tokens).toEqual({ border: parseColor('#333') })
    expect(theme.grain.amount).toBe(0.4)
    expect(theme.surfaces).toEqual({})
    expect(notes.map((n) => n.message).join('\n')).toMatch(/tokens\.card is not a colour/)
    expect(notes.map((n) => n.message).join('\n')).toMatch(/tokens\.display is not a colour token/)
    expect(notes.map((n) => n.message).join('\n')).toMatch(/surfaces\.body is not a surface/)
    expect(notes.map((n) => n.message).join('\n')).toMatch(/theme\.unknownThing/)
    expect(notes.map((n) => n.message).join('\n')).toMatch(/grain\.amount 5 is outside/)
  })

  it('only names files that are in the archive, and of the right kind', () => {
    const { theme, notes } = read({
      window: { material: 'image', image: { src: '../../../etc/passwd' } },
      surfaces: { sidechat: { image: { src: 'https://example.com/x.png' } }, sidebar: { image: { src: 'fonts/Literata.woff2' } } },
      fonts: { faces: [{ family: 'Literata', src: 'images/desk.jpg' }] },
      logo: { mark: './images/mark.svg' }
    })
    expect(theme.window).toEqual({ material: 'solid' })
    expect(theme.surfaces).toEqual({})
    expect(theme.fonts.faces).toEqual([])
    expect(theme.logo).toEqual({ mark: 'images/mark.svg' })
    expect(notes.some((n) => /not in the theme/.test(n.message))).toBe(true)
    expect(notes.some((n) => /not an image/.test(n.message))).toBe(true)
    expect(notes.some((n) => /not a font/.test(n.message))).toBe(true)
  })

  it('refuses font names that could leave a quoted string', () => {
    const { theme } = read({ fonts: { ui: { family: ['Inter"; } body { color: red', 'Literata', 'serif', 'a\\b'] } } })
    expect(theme.fonts.ui?.family).toEqual(['Literata', 'serif'])
  })

  it('keeps pictures off the reading surface', () => {
    const { theme, notes } = read({ surfaces: { reading: { image: { src: 'images/desk.jpg' }, grain: 0.05 } } })
    expect(theme.surfaces.reading).toEqual({ grain: 0.05 })
    expect(notes.some((n) => /reading surface and stays plain/.test(n.message))).toBe(true)
  })
})

describe('compileTheme', () => {
  it('writes only theme properties, and only under :root', () => {
    const compiled = compile({
      tokens: { card: '#222' },
      window: { material: 'image', image: { src: 'images/desk.jpg', blur: 12, dim: 0.3 } },
      grain: { amount: 0.2, scale: 1.5 },
      surfaces: { sidechat: { color: '#00000066', image: { src: 'images/linen.png', fit: 'tile', tint: '#00000080' } }, popover: { blur: 8 } },
      fonts: { faces: [{ family: 'Literata', src: 'fonts/Literata.woff2', weight: '200 900' }], reading: { family: ['Literata', 'serif'], size: 17, lineHeight: 1.7 }, code: { size: 15 } },
      logo: { mark: 'images/mark.svg' }
    })
    const declarations = declarationsOf(compiled.css)
    expect(declarations.length).toBeGreaterThan(50)
    for (const { selector, property } of declarations) {
      expect(selector).toBe(':root')
      expect(THEME_PROPERTIES.has(property), property).toBe(true)
    }
    expect(compiled.css).not.toMatch(/https?:/)
  })

  it('is complete: every colour token is written even when the theme names three colours', () => {
    const compiled = compile({})
    for (const token of COLOR_TOKENS) expect(compiled.values[tokenProperty(token)], token).toBeTruthy()
    expect(compiled.values['--color-scheme']).toBe('dark')
    expect(compiled.values['--shadow-rgb']).toBe('0 0 0')
  })

  it('keeps reading and code surfaces opaque, and says so', () => {
    const compiled = compile({ surfaces: { reading: { color: 'rgba(27, 26, 23, 0.4)' }, code: { opacity: 0.5 } } })
    expect(parseColor(compiled.values['--bg']!)!.a).toBe(1)
    expect(parseColor(compiled.values['--code-bg']!)!.a).toBe(1)
    expect(compiled.notes.filter((n) => /must be opaque/.test(n.message))).toHaveLength(2)
  })

  it('makes every translucent surface opaque and drops grain and pictures under reduced transparency', () => {
    const compiled = compile({
      window: { material: 'image', image: { src: 'images/desk.jpg' } },
      surfaces: { sidebar: { color: 'rgba(0, 0, 0, 0.3)', grain: 0.2 }, titlebar: { image: { src: 'images/desk.jpg' } } }
    })
    const rt = compiled.reducedTransparency
    for (const property of ['--chrome', '--glass', '--popover', '--sidebar-bg']) expect(parseColor(rt[property]!)?.a, property).toBe(1)
    expect(rt['--glass-grain']).toBe('none')
    expect(rt['--sidebar-image']).toBe('none')
    expect(rt['--titlebar-image']).toBe('none')
    expect(rt['--window-image']).toBe('none')
    expect(compiled.increasedContrast['--border']).toBeTruthy()
    expect(compiled.css).toMatch(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{\n:root \{/)
  })

  it('lines image layers up: grain, tint, picture', () => {
    const compiled = compile({ surfaces: { sidechat: { image: { src: 'images/linen.png', fit: 'tile', scale: 0.5, tint: '#0008', position: 'top' } } } })
    const layers = (name: string): string[] => splitLayers(compiled.values[`--sidechat-image${name}`]!)
    expect(layers('')).toHaveLength(3)
    expect(layers('')[0]).toBe('var(--glass-grain)')
    expect(layers('')[1]).toMatch(/^linear-gradient/)
    expect(layers('')[2]).toBe(`url("${THEME_URL_PREFIX}abc/images/linen.png")`)
    expect(layers('-size')).toEqual(['var(--grain-size)', 'auto', '64px 48px'])
    expect(layers('-repeat')).toEqual(['repeat', 'repeat', 'repeat'])
    expect(layers('-position')[2]).toBe('50% 0%')
  })

  it('turns grain into a data URL the CSP already allows', () => {
    const strong = compile({ grain: { amount: 0.3, scale: 2 } })
    expect(strong.values['--glass-grain']).toMatch(/^url\("data:image\/svg\+xml,/)
    expect(decodeURIComponent(strong.values['--glass-grain']!)).toContain('slope="0.3"')
    expect(strong.values['--grain-size']).toBe('320px 320px')
    expect(compile({ grain: { amount: 0 } }).values['--glass-grain']).toBe('none')
    expect(compile({ grain: { texture: 'images/linen.png', scale: 2 } }).values['--grain-size']).toBe('256px 192px')
  })

  it('draws a texture as authored at 0.12, and asks for it faded or strengthened otherwise', () => {
    const own = compile({ grain: { texture: 'images/linen.png' }, surfaces: { reading: { grain: 0.06 }, titlebar: { grain: 0.12 } } })
    expect(own.values['--glass-grain']).toBe(`url("${THEME_URL_PREFIX}abc/images/linen.png")`)
    expect(own.values['--reading-image']).toBe(`url("${THEME_URL_PREFIX}abc/images/linen.png?strength=0.5")`)
    expect(own.values['--titlebar-image']).toBe('var(--glass-grain)')
    const strong = compile({ grain: { texture: 'images/linen.png', amount: 0.3 } })
    expect(strong.values['--glass-grain']).toBe(`url("${THEME_URL_PREFIX}abc/images/linen.png?strength=2.5")`)
    expect(compile({ grain: { texture: 'images/linen.png', amount: 0 } }).values['--glass-grain']).toBe('none')
  })

  it('writes fonts with quotes, fallbacks and the code scale', () => {
    const compiled = compile({
      fonts: {
        faces: [{ family: 'Literata', src: 'fonts/Literata.woff2', weight: '200 900', style: 'italic' }],
        ui: { family: 'Literata', size: 30 }, code: { family: ['ui-monospace'], size: 15 }, heading: { weight: 650, letterSpacing: -0.02 }
      }
    })
    expect(compiled.values['--font-ui']).toBe('"Literata", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
    expect(compiled.values['--ui-size']).toBe('18px')
    expect(compiled.values['--font-mono']).toMatch(/^ui-monospace, ui-monospace/)
    expect(compiled.values['--code-scale']).toBe('1.2')
    expect(compiled.values['--heading-weight']).toBe('650')
    expect(compiled.values['--heading-letter-spacing']).toBe('-0.02em')
    expect(compiled.faces).toEqual([{ family: 'Literata', src: 'fonts/Literata.woff2', weight: '200 900', style: 'italic' }])
  })

  it('tells main what to do with the window', () => {
    expect(compile({}).native).toEqual({ appearance: 'dark', vibrancy: true, background: '#1b1a17' })
    const pictured = compile({ window: { material: 'image', color: '#101010', image: { src: 'images/desk.jpg', blur: 10 } } })
    expect(pictured.native).toEqual({ appearance: 'dark', vibrancy: false, background: '#101010' })
    expect(pictured.values['--window-filter']).toBe('blur(10px)')
    expect(pictured.values['--window-bleed']).toBe('-20px')
    expect(pictured.logo).toBeNull()
    expect(compile({ logo: { mark: 'images/mark.svg' } }).logo).toBe(`${THEME_URL_PREFIX}abc/images/mark.svg`)
  })

  it('derives a readable light theme from three colours', () => {
    const light = compile({ appearance: 'light', palette: { background: '#f7f5f0', text: '#1d1b16', accent: '#8a4b0f' } })
    expect(light.values['--color-scheme']).toBe('light')
    expect(light.native.appearance).toBe('light')
    const { theme } = read({ appearance: 'light', palette: { background: '#f7f5f0', text: '#1d1b16', accent: '#8a4b0f' } })
    expect(auditTheme(theme, light).filter((n) => n.level === 'warning')).toEqual([])
    // Button labels are chosen for the accent, not copied from the default.
    expect(contrast(parseColor(light.values['--accent-fg']!)!, parseColor(light.values['--accent']!)!)).toBeGreaterThanOrEqual(4.5)
  })

  it('warns about text nobody can read', () => {
    const { theme } = read({ palette: { background: '#202020', text: '#2a2a2a', accent: '#d9a441' } })
    const compiled = compileTheme(theme, { url: (path) => path, assets })
    expect(auditTheme(theme, compiled).some((n) => /reading surface reads at 1\.\d:1/.test(n.message))).toBe(true)
  })
})
