/**
 * Custom notebook folders.
 *
 * A notebook usually lives in a UUID directory under the user's
 * writing-notebooks root. At creation the user may instead pick any folder;
 * this per-user registry maps the notebook id to that folder. It lives in the
 * user's directory, so deleting the user deletes the registry with it, and
 * both OpenCourse and OpenCourse Notebook read the same file.
 */
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataRoot, userWritingNotebookLocationsFile, userWritingNotebooksDir } from './paths'
import { requireUser } from './users'

const UUID = /^[0-9a-f-]{36}$/i
const file = (): string => userWritingNotebookLocationsFile(requireUser())
export function notebookLocations(): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result: Record<string, string> = {}
    for (const [id, path] of Object.entries(value as Record<string, unknown>)) if (UUID.test(id) && typeof path === 'string' && isAbsolute(path)) result[id] = path
    return result
  } catch { return {} }
}
function saveLocations(value: Record<string, string>): void {
  const target = file(), temporary = `${target}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
}
export function registerNotebookLocation(id: string, directory: string): void { const value = notebookLocations(); value[id] = directory; saveLocations(value) }
export function unregisterNotebookLocation(id: string): void { const value = notebookLocations(); delete value[id]; saveLocations(value) }
export function writingNotebookDirectory(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid notebook identity.')
  return notebookLocations()[id] ?? join(userWritingNotebooksDir(requireUser()), id)
}
/** Validate a user-chosen folder and return its canonical path. Throws with a renderer-ready message. */
export function resolveNotebookFolder(folder: string): string {
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Choose a folder for the notebook.')
  let real: string
  try { real = realpathSync(folder) } catch { throw new Error('The chosen folder no longer exists.') }
  if (!lstatSync(real).isDirectory()) throw new Error('The chosen path is not a folder.')
  const data = existsSync(dataRoot()) ? realpathSync(dataRoot()) : null
  if (data && (real === data || real.startsWith(data + sep))) throw new Error('Choose a folder outside the OpenCourse data directory.')
  if (existsSync(join(real, 'notebook.json'))) throw new Error('That folder is already a notebook.')
  const existing = Object.values(notebookLocations())
  if (existing.some(path => path === real)) throw new Error('That folder already belongs to another notebook.')
  if (existing.some(path => real.startsWith(path + sep) || path.startsWith(real + sep))) throw new Error('That folder overlaps another notebook folder.')
  try { accessSync(real, constants.W_OK) } catch { throw new Error('The chosen folder is not writable.') }
  return real
}