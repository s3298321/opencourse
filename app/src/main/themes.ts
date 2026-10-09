/**
 * Installed themes, for whoever is signed in: importing, listing, removing and
 * applying them.
 *
 *   users/<id>/themes/<uuid>/files/      the archive, as imported
 *   users/<id>/themes/<uuid>/meta.json   the app's own record
 *
 * A theme is read the way courses are: nothing lands in themes/ until the
 * whole archive has been unpacked into staging and read there, so a refused
 * archive leaves the installed ones exactly as they were. Applying one is a
 * preference (`preferences.json { theme }`); its absence is the app's own look,
 * which is not a theme and cannot be removed.
 *
 * Built-in White is bundled data and has a reserved preference id. Every id
 * used to build a filesystem path must still be an installed UUID.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInside } from '../core/safepath'
import { extensionOf } from '../core/import'
import { THEME_IMAGE_EXTENSIONS, THEME_POLICY } from '../core/theme/assets'
import { auditTheme } from '../core/theme/audit'
import { compileTheme, THEME_URL_PREFIX, type CompiledTheme } from '../core/theme/compile'
import { compiledWhiteTheme, whiteTheme } from '../core/theme/builtin'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
import type { ActiveTheme, ThemeImportResult, ThemeSummary } from '../core/types'
import { readThemeDirectory, type ThemeDirectory } from './theme-files'
import { extractArchive } from './unzip'
import { userThemeDir, userThemesDir } from './paths'
import { readPreferences, writePreferences } from './preferences'
import { currentUserId, requireUser } from './users'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Installed {
  id: string
  dir: string
  installedAt: number
  read: ThemeDirectory | { error: string }
}

/** The URL a theme's picture is served at; protocol.ts answers it. */
export function themeUrl(themeId: string, path: string): string {
  return `${THEME_URL_PREFIX}${themeId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function filesDir(dir: string): string {
  return join(dir, 'files')
}

function readInstalled(userId: string, id: string): Installed | null {
  if (!UUID.test(id)) return null
  const dir = userThemeDir(userId, id)
  if (!existsSync(join(dir, 'meta.json'))) return null
  let installedAt = 0
  try {
    installedAt = Number(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).installedAt) || 0
  } catch { /* a hand-damaged record costs the sort order, not the theme */ }
  return { id, dir, installedAt, read: readThemeDirectory(filesDir(dir)) }
}

function installed(userId: string): Installed[] {
  const root = userThemesDir(userId)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => UUID.test(name))
    .map((name) => readInstalled(userId, name))
    .filter((entry): entry is Installed => entry !== null)
    .sort((a, b) => a.installedAt - b.installedAt)
}

function compile(entry: Installed & { read: ThemeDirectory }): CompiledTheme {
  return compileTheme(entry.read.theme, { url: (path) => themeUrl(entry.id, path), assets: entry.read.assets })
}

function summarize(entry: Installed, activeId: string | undefined): ThemeSummary {
  if ('error' in entry.read) {
    return {
      id: entry.id, portableId: '', name: 'Unreadable theme', appearance: 'dark', preview: null, swatch: [],
      notes: [], active: entry.id === activeId, error: entry.read.error
    }
  }
  const { theme, notes } = entry.read
  const compiled = compile(entry as Installed & { read: ThemeDirectory })
  return {
    id: entry.id,
    portableId: theme.id,
    name: theme.name,
    ...(theme.author ? { author: theme.author } : {}),
    ...(theme.version ? { version: theme.version } : {}),
    ...(theme.description ? { description: theme.description } : {}),
    appearance: theme.appearance,
    preview: theme.preview ? themeUrl(entry.id, theme.preview) : null,
    swatch: ['--bg', '--card', '--accent', '--fg'].map((property) => compiled.values[property] ?? ''),
    notes: [...notes, ...compiled.notes, ...auditTheme(theme, compiled)],
    active: entry.id === activeId
  }
}

export function listThemes(): ThemeSummary[] {
  const userId = requireUser()
  const active = readPreferences().theme
  return [{
    id: WHITE_THEME_ID, portableId: whiteTheme.id, name: whiteTheme.name,
    author: whiteTheme.author, description: whiteTheme.description,
    appearance: 'light', preview: null, builtin: true,
    swatch: ['--bg', '--card', '--accent', '--fg'].map((property) => compiledWhiteTheme.values[property]!),
    notes: [], active: active === WHITE_THEME_ID
  }, ...installed(userId).map((entry) => summarize(entry, active))]
}

/** The applied theme, compiled - or null for the app's own look. */
function activeEntry(): (Installed & { read: ThemeDirectory }) | null {
  const userId = currentUserId()
  if (!userId) return null
  const id = readPreferences().theme
  if (!id) return null
  const entry = readInstalled(userId, id)
  // A theme that has gone, or can no longer be read, is the default look -
  // never a blank window.
  if (!entry || 'error' in entry.read) return null
  return entry as Installed & { read: ThemeDirectory }
}

export function getActiveTheme(): ActiveTheme {
  if (currentUserId() && readPreferences().theme === WHITE_THEME_ID) {
    return {
      id: WHITE_THEME_ID, name: whiteTheme.name, css: compiledWhiteTheme.css,
      appearance: 'light', faces: [], logo: null
    }
  }
  const entry = activeEntry()
  if (!entry) return { id: null }
  const compiled = compile(entry)
  return {
    id: entry.id,
    name: entry.read.theme.name,
    css: compiled.css,
    appearance: compiled.appearance,
    faces: compiled.faces.map(({ family, weight, style }) => ({ family, weight, style })),
    logo: compiled.logo
  }
}

/** What the window itself should do; null when no theme is applied (or nobody is signed in). */
export function activeThemeNative(): CompiledTheme['native'] | null {
  if (currentUserId() && readPreferences().theme === WHITE_THEME_ID) return compiledWhiteTheme.native
  const entry = activeEntry()
  return entry ? compile(entry).native : null
}

export function applyTheme(id: string | null): ActiveTheme {
  const userId = requireUser()
  const { theme: _previous, ...rest } = readPreferences()
  if (id === null) {
    writePreferences(rest)
    return { id: null }
  }
  if (typeof id !== 'string') throw new Error('invalid theme id')
  if (id === WHITE_THEME_ID) {
    writePreferences({ ...rest, theme: id })
    return getActiveTheme()
  }
  const entry = readInstalled(userId, id)
  if (!entry) throw new Error('That theme is not installed.')
  if ('error' in entry.read) throw new Error(`That theme cannot be applied: ${entry.read.error}`)
  writePreferences({ ...rest, theme: id })
  return getActiveTheme()
}

export function removeTheme(id: string): { wasActive: boolean } {
  const userId = requireUser()
  if (id === WHITE_THEME_ID) throw new Error('Built-in themes cannot be removed.')
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid theme id')
  const entry = readInstalled(userId, id)
  if (!entry) throw new Error('That theme is not installed.')
  const { theme: active, ...rest } = readPreferences()
  const wasActive = active === id
  if (wasActive) writePreferences(rest)
  rmSync(entry.dir, { recursive: true, force: true })
  return { wasActive }
}

/** The bytes of one of the active theme's fonts, for a FontFace in the renderer. */
export function themeFontData(id: string, index: number): Uint8Array {
  const entry = activeEntry()
  // Only the applied theme's fonts are ever needed, so only they are served.
  if (!entry || entry.id !== id || !Number.isInteger(index)) throw new Error('That font is not part of the applied theme.')
  const face = entry.read.theme.fonts.faces[index]
  const file = face ? resolveInside(filesDir(entry.dir), face.src) : null
  if (!file) throw new Error('That font is not part of the applied theme.')
  return new Uint8Array(readFileSync(file))
}

/**
 * The file behind opencourse://themes/<id>/<path>, for the current user's
 * installed theme, and only if it is a picture. Fonts go over IPC instead,
 * and theme.json is never served at all.
 */
export function themeImageFile(id: string, path: string): string | null {
  const userId = currentUserId()
  if (!userId || !UUID.test(id) || !THEME_IMAGE_EXTENSIONS.has(extensionOf(path))) return null
  const dir = userThemeDir(userId, id)
  if (!existsSync(join(dir, 'meta.json'))) return null
  return resolveInside(filesDir(dir), path)
}

export type DuplicateChoice = 'replace' | 'keep' | 'cancel'

/**
 * Unpacks, reads and installs a theme archive. An archive whose `id` is
 * already installed asks `onDuplicate` - replacing keeps the installed UUID,
 * so a theme that is applied stays applied and simply updates.
 */
export async function importThemeZip(
  zipPath: string,
  onDuplicate: (existing: ThemeSummary, incomingName: string) => Promise<DuplicateChoice>
): Promise<ThemeImportResult> {
  const owner = requireUser()
  let size: number
  try {
    size = statSync(zipPath).size
  } catch {
    return { status: 'rejected', message: 'That file could not be read.' }
  }
  if (size > THEME_POLICY.limits.archiveBytes) {
    return { status: 'rejected', message: `The archive is larger than ${THEME_POLICY.limits.archiveBytes / 1024 / 1024} MB.` }
  }

  const staging = mkdtempSync(join(tmpdir(), 'opencourse-theme-'))
  try {
    const unpacked = join(staging, 'files')
    mkdirSync(unpacked)
    const { error } = await extractArchive(zipPath, unpacked, THEME_POLICY)
    if (error) return { status: 'rejected', message: error }
    const read = readThemeDirectory(unpacked)
    if ('error' in read) return { status: 'rejected', message: read.error }

    const active = readPreferences().theme
    const existing = installed(owner).find((entry) => !('error' in entry.read) && entry.read.theme.id === read.theme.id)
    let id: string = randomUUID()
    if (existing) {
      const choice = await onDuplicate(summarize(existing, active), read.theme.name)
      if (choice === 'cancel') return { status: 'cancelled' }
      if (choice === 'replace') id = existing.id
    }
    if (requireUser() !== owner) return { status: 'rejected', message: 'The active user changed during import.' }

    writeFileSync(join(staging, 'meta.json'), JSON.stringify({ installedAt: existing && id === existing.id ? existing.installedAt : Date.now() }, null, 2))
    const target = userThemeDir(owner, id)
    mkdirSync(userThemesDir(owner), { recursive: true })
    // Swap in one rename where the old theme can be moved aside first, so a
    // failure part-way leaves either the old theme or the new one, never half.
    const aside = existsSync(target) ? `${target}.replaced-${process.pid}` : null
    if (aside) renameSync(target, aside)
    try {
      // Staging is in the system temp directory, which need not share a
      // volume with userData; a rename across volumes fails, so copy then.
      try { renameSync(staging, target) } catch { cpSync(staging, target, { recursive: true }) }
    } catch (err) {
      rmSync(target, { recursive: true, force: true })
      if (aside) renameSync(aside, target)
      throw err
    }
    if (aside) rmSync(aside, { recursive: true, force: true })

    const entry = readInstalled(owner, id)
    if (!entry) return { status: 'rejected', message: 'The theme could not be installed.' }
    return { status: 'ok', theme: summarize(entry, readPreferences().theme), replaced: Boolean(existing && id === existing.id) }
  } catch (err) {
    return { status: 'rejected', message: `Could not install the theme: ${(err as Error).message}` }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
