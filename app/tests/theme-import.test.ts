/**
 * Installing themes, against real archives built byte by byte - the ones a
 * real archiver refuses to make. A theme archive is narrower than a course
 * archive: pictures, fonts and JSON, judged by their bytes, nothing that runs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeZip, type ZipMember } from './helpers/zip'

const root = mkdtempSync(join(tmpdir(), 'opencourse-themes-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  }
}))

const { createUser, deleteUser, listUsers, switchUser } = await import('../src/main/users')
const { activeThemeNative, applyTheme, getActiveTheme, importThemeZip, listThemes, removeTheme, themeFontData, themeImageFile } = await import('../src/main/themes')
const { readPreferences } = await import('../src/main/preferences')
const { WHITE_THEME_ID } = await import('../src/core/theme/builtin-ids')
const importedThemes = () => listThemes().filter((theme) => !theme.builtin)

/** A real 1×1 PNG: sniffed as one, two pixels short of nothing. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const FONT = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 1)])

const theme = (over: Record<string, unknown> = {}): string => JSON.stringify({
  format: 1, id: 'paper', name: 'Paper', appearance: 'light',
  palette: { background: '#f7f5f0', text: '#1d1b16', accent: '#8a4b0f' },
  surfaces: { sidebar: { image: { src: 'images/linen.png', fit: 'tile', tint: '#ffffff80' } } },
  fonts: { faces: [{ family: 'Ledger', src: 'fonts/ledger.woff2' }], brand: { family: 'Ledger' } },
  logo: { mark: 'images/mark.png' },
  ...over
})

const good = (over: Record<string, unknown> = {}): ZipMember[] => [
  { name: 'theme.json', content: theme(over) },
  { name: 'images/linen.png', bytes: PNG },
  { name: 'images/mark.png', bytes: PNG },
  { name: 'fonts/ledger.woff2', bytes: FONT },
  { name: 'LICENSE.txt', content: 'free' }
]

let n = 0
function zip(members: ZipMember[]): string {
  n += 1
  return makeZip(join(root, `theme-${n}.zip`), members)
}

const keep = async (): Promise<'keep'> => 'keep'
const replace = async (): Promise<'replace'> => 'replace'

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  for (const user of listUsers()) deleteUser(user.id)
  dataDir = join(root, `data-${++n}`)
  mkdirSync(dataDir, { recursive: true })
  createUser('Ada')
})

describe('importThemeZip', () => {
  it('installs a theme under its own UUID, with the archive kept apart from the app\'s record', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    expect(result.replaced).toBe(false)
    expect(result.theme).toMatchObject({ portableId: 'paper', name: 'Paper', appearance: 'light', active: false })
    expect(result.theme.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(importedThemes().map((t) => t.name)).toEqual(['Paper'])
    expect(result.theme.swatch).toHaveLength(4)
  })

  it('refuses anything that runs, and anything whose bytes disagree with its name', async () => {
    for (const [member, reason] of [
      [{ name: 'evil.js', content: 'alert(1)' }, /file type not allowed/],
      [{ name: 'style.css', content: 'body{}' }, /file type not allowed/],
      [{ name: 'index.html', content: '<script>' }, /file type not allowed/],
      [{ name: 'images/fake.png', content: '<html><script>alert(1)</script>' }, /not the image its name says/],
      [{ name: 'fonts/fake.woff2', content: 'not a font' }, /not a font/],
      [{ name: '../escape.png', bytes: PNG }, /escapes|invalid relative path|outside/],
      [{ name: 'images/link.png', symlinkTo: '/etc/passwd' }, /symlink/]
    ] as Array<[ZipMember, RegExp]>) {
      const result = await importThemeZip(zip([...good(), member]), keep)
      expect(result.status, member.name).toBe('rejected')
      if (result.status === 'rejected') expect(result.message, member.name).toMatch(reason)
    }
    expect(importedThemes()).toEqual([])
  })

  it('refuses what is not a theme, and leaves the installed ones alone', async () => {
    await importThemeZip(zip(good()), keep)
    for (const members of [
      [{ name: 'readme.txt', content: 'hello' }],
      [{ name: 'theme.json', content: '{ nope' }],
      [{ name: 'theme.json', content: JSON.stringify({ format: 9, id: 'x', name: 'X' }) }]
    ] as ZipMember[][]) {
      expect((await importThemeZip(zip(members), keep)).status).toBe('rejected')
    }
    expect(importedThemes().map((t) => t.name)).toEqual(['Paper'])
  })

  it('imports with notes rather than refusing a theme with a bad field', async () => {
    const result = await importThemeZip(zip(good({ tokens: { card: 'nope' }, surfaces: { reading: { image: { src: 'images/linen.png' } } } })), keep)
    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    expect(result.theme.notes.map((note) => note.message).join('\n')).toMatch(/tokens\.card/)
    expect(result.theme.notes.map((note) => note.message).join('\n')).toMatch(/reading surface/)
  })

  it('strips the folder Finder wraps an archive in', async () => {
    const result = await importThemeZip(zip(good().map((m) => ({ ...m, name: `paper/${m.name}` }))), keep)
    expect(result.status).toBe('ok')
  })

  it('replaces a theme with the same id in place, keeping it applied', async () => {
    const first = await importThemeZip(zip(good()), keep)
    if (first.status !== 'ok') throw new Error('import failed')
    applyTheme(first.theme.id)
    const second = await importThemeZip(zip(good({ name: 'Paper, revised' })), replace)
    if (second.status !== 'ok') throw new Error('reimport failed')
    expect(second.replaced).toBe(true)
    expect(second.theme.id).toBe(first.theme.id)
    expect(second.theme.active).toBe(true)
    expect(importedThemes().map((t) => t.name)).toEqual(['Paper, revised'])
    const active = getActiveTheme()
    expect(active.id === null ? null : active.name).toBe('Paper, revised')
  })

  it('keeps both when asked, and cancels without touching anything', async () => {
    await importThemeZip(zip(good()), keep)
    expect((await importThemeZip(zip(good()), async () => 'cancel')).status).toBe('cancelled')
    expect(importedThemes()).toHaveLength(1)
    expect((await importThemeZip(zip(good()), keep)).status).toBe('ok')
    expect(importedThemes()).toHaveLength(2)
  })
})

describe('applying and removing', () => {
  it('applies by preference and compiles for the renderer; null is the app\'s own look', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error('import failed')
    expect(getActiveTheme()).toEqual({ id: null })
    const active = applyTheme(result.theme.id)
    if (active.id === null) throw new Error('not applied')
    expect(active.css).toMatch(/^\/\* Paper/)
    expect(active.appearance).toBe('light')
    expect(active.faces).toEqual([{ family: 'Ledger', weight: '400', style: 'normal' }])
    expect(active.logo).toBe(`opencourse://themes/${result.theme.id}/images/mark.png`)
    expect(readPreferences().theme).toBe(result.theme.id)
    expect(applyTheme(null)).toEqual({ id: null })
    expect(readPreferences().theme).toBeUndefined()
  })

  it('refuses ids that are not installed, or not ids', async () => {
    expect(() => applyTheme('../../etc')).toThrow()
    expect(() => applyTheme('00000000-0000-4000-8000-000000000000')).toThrow(/not installed/)
    expect(() => removeTheme('../x')).toThrow(/invalid/)
  })

  it('serves fonts only from the applied theme, and pictures only by their own paths', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error('import failed')
    expect(() => themeFontData(result.theme.id, 0)).toThrow(/applied theme/)
    applyTheme(result.theme.id)
    expect(Buffer.from(themeFontData(result.theme.id, 0)).subarray(0, 4).toString()).toBe('wOF2')
    expect(() => themeFontData(result.theme.id, 1)).toThrow()
    expect(themeImageFile(result.theme.id, 'images/linen.png')).toMatch(/files\/images\/linen\.png$/)
    expect(themeImageFile(result.theme.id, 'theme.json')).toBeNull()
    expect(themeImageFile(result.theme.id, 'fonts/ledger.woff2')).toBeNull()
    expect(themeImageFile(result.theme.id, '../meta.json')).toBeNull()
    expect(themeImageFile('not-a-uuid', 'images/linen.png')).toBeNull()
  })

  it('removing the applied theme returns to the app\'s own look', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error('import failed')
    applyTheme(result.theme.id)
    expect(removeTheme(result.theme.id)).toEqual({ wasActive: true })
    expect(getActiveTheme()).toEqual({ id: null })
    expect(importedThemes()).toEqual([])
  })

  it('belongs to one user: another sees none of it, and a missing theme reads as none', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error('import failed')
    applyTheme(result.theme.id)
    const ada = listUsers()[0]!.id
    createUser('Grace')
    expect(importedThemes()).toEqual([])
    expect(getActiveTheme()).toEqual({ id: null })
    expect(themeImageFile(result.theme.id, 'images/linen.png')).toBeNull()
    switchUser(ada)
    expect(getActiveTheme().id).toBe(result.theme.id)
    rmSync(join(dataDir, 'users', ada, 'themes', result.theme.id), { recursive: true })
    expect(getActiveTheme()).toEqual({ id: null })
  })

  it('lists an installed theme that can no longer be read, so it can be removed', async () => {
    const result = await importThemeZip(zip(good()), keep)
    if (result.status !== 'ok') throw new Error('import failed')
    const user = listUsers()[0]!.id
    const file = join(dataDir, 'users', user, 'themes', result.theme.id, 'files', 'theme.json')
    writeFileSync(file, '{ broken')
    const [listed] = importedThemes()
    expect(listed?.error).toMatch(/not valid JSON/)
    expect(() => applyTheme(result.theme.id)).toThrow(/cannot be applied/)
    removeTheme(result.theme.id)
    expect(existsSync(file)).toBe(false)
  })
})


describe('built-in White theme', () => {
  it('ships for every user while dark stays the initial default', () => {
    expect(getActiveTheme()).toEqual({ id: null })
    expect(activeThemeNative()).toBeNull()
    expect(listThemes()).toMatchObject([{ id: WHITE_THEME_ID, builtin: true, active: false, appearance: 'light' }])
    createUser('Grace')
    expect(listThemes()).toMatchObject([{ id: WHITE_THEME_ID, builtin: true, active: false }])
    expect(getActiveTheme()).toEqual({ id: null })
  })

  it('persists White per user, preserves the logo, and returns to dark', () => {
    const ada = listUsers()[0]!.id
    const active = applyTheme(WHITE_THEME_ID)
    expect(active).toMatchObject({ id: WHITE_THEME_ID, appearance: 'light', logo: null, faces: [] })
    expect(readPreferences().theme).toBe(WHITE_THEME_ID)
    expect(activeThemeNative()).toEqual({ appearance: 'light', vibrancy: true, background: '#f7f7f9' })
    expect(listThemes()[0].active).toBe(true)
    createUser('Grace')
    expect(getActiveTheme()).toEqual({ id: null })
    switchUser(ada)
    expect(getActiveTheme()).toEqual(active)
    expect(applyTheme(null)).toEqual({ id: null })
    expect(readPreferences().theme).toBeUndefined()
    expect(activeThemeNative()).toBeNull()
  })

  it('cannot remove a built-in theme or serve imported assets through its id', () => {
    applyTheme(WHITE_THEME_ID)
    expect(() => removeTheme(WHITE_THEME_ID)).toThrow(/Built-in themes cannot be removed/)
    expect(getActiveTheme().id).toBe(WHITE_THEME_ID)
    expect(() => themeFontData(WHITE_THEME_ID, 0)).toThrow(/applied theme/)
    expect(themeImageFile(WHITE_THEME_ID, 'images/mark.png')).toBeNull()
  })
})
