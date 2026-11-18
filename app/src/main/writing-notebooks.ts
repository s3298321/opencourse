import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, lstatSync, watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { MAX_WRITING_FILE_BYTES, MAX_WRITING_IMPORT_FILES, MAX_WRITING_PAGE_BYTES, MAX_WRITING_PAGES, MAX_WRITING_TEXT_BYTES, type NotebookAssociation, type WritingFileRead, type WritingNotebook, type WritingNotebookHit, type WritingNotebookPage, type WritingNotebookSaveResult } from '../core/writing-notebooks/types'
import { buildWritingTree, fileName, folderName, pageFileName, pageName, pageTitle, treeDepth, treeJoin, treeName, treeParent, treePath, MAX_WRITING_FOLDER_DEPTH, WRITING_TREE_DIR } from '../core/writing-notebooks/tree'
import { decodableAsUtf8, looksBinary } from '../core/writing-notebooks/files'
import { userWritingNotebooksDir } from './paths'
import { requireUser } from './users'
import { db, tx } from './db'
import { getCourse } from './courses'
import { getDocument } from './documents'
import { getProject } from './coach'
import { notebookLocations, registerNotebookLocation, resolveNotebookFolder, unregisterNotebookLocation, writingNotebookDirectory } from './writing-notebook-locations'
import { migrateWritingTree, resolveWritingTreePath, scanWritingTree, writingTreeRoot } from './writing-notebook-tree'

export const writingNotebookEvents = new EventEmitter()
const uuid = (value: string): string => { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid notebook identity.'); return value }
const root = () => userWritingNotebooksDir(requireUser())
export { writingNotebookDirectory } from './writing-notebook-locations'
function title(value: string): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('Use a title between 1 and 200 characters.'); return value.trim() }
function atomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}
/** Same atomic swap for plain text; the .tmp name keeps the write out of the tree scan. */
function atomicText(file: string, text: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, text, 'utf8'); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}
export function resolveNotebookAssociation(value?: NotebookAssociation): NotebookAssociation | undefined {
  if (!value) return undefined
  let name: string | undefined
  if (value.kind === 'course') name = getCourse(value.id)?.title
  else if (value.kind === 'document') name = getDocument(value.id)?.title
  else if (value.kind === 'coach') name = getProject(value.id)?.name
  if (!name) throw new Error('The associated source is unavailable. Install or open it first.')
  return { kind: value.kind, id: value.id, title: name }
}
/** Legacy page files were named after the page id: `<uuid>.json`. */
const LEGACY_PAGE_FILE = /^([0-9a-f-]{36})\.json$/i

export function getWritingNotebook(id: string): WritingNotebook {
  const metadata = join(writingNotebookDirectory(id), 'notebook.json')
  if (!existsSync(metadata)) throw new Error('This notebook is unavailable. Its folder may have been moved or deleted.')
  const result = JSON.parse(readFileSync(metadata, 'utf8')) as WritingNotebook & { pages: { id: string; path?: string }[] }
  if (result.version !== 1 || result.id !== id || !Array.isArray(result.pages) || !result.pages.length) throw new Error('This notebook could not be read. Its files have been preserved.')
  // Legacy metadata lists pages as { id, title }; their files were `<id>.json`.
  result.pages = result.pages.map(page => ({ id: uuid(page.id), path: treePath(typeof page.path === 'string' ? page.path : `${page.id}.json`) }))
  const seen = new Set<string>(), unique: { id: string; path: string }[] = []
  for (const page of result.pages) if (!seen.has(page.id) && !unique.some(other => other.path === page.path)) { seen.add(page.id); unique.push(page) }
  result.pages = unique
  result.showLineNumbers = result.showLineNumbers === true
  result.textLayout = result.textLayout === 'thin' ? 'thin' : 'wide'
  if (result.association) { try { result.associationAvailable = !!resolveNotebookAssociation(result.association) } catch { result.associationAvailable = false } }
  migrateWritingTree(id, result.pages.map(page => page.id))
  // The disk owns the hierarchy: reconcile the metadata page list with the files
  // actually on disk — adopting files moved in Finder, retitling legacy
  // <uuid>.json page files to their title, and dropping pages whose file vanished.
  const pages = reconcileWritingPages(id, result.pages)
  if (!pages.length) throw new Error('This notebook could not be read. Its files have been preserved.')
  if (pages.length !== result.pages.length || pages.some((page, index) => page.path !== result.pages[index]?.path)) {
    result.pages = pages
    if (!pages.some(page => page.id === result.selectedPageId)) result.selectedPageId = pages[0]!.id
    writeMetadata(result)
  }
  result.tree = buildWritingTree(scanWritingTree(id), result.pages)
  return result
}
/**
 * Read one tree file as JSON, capped so a huge foreign file is never slurped:
 * pages are bounded by MAX_WRITING_PAGE_BYTES, so anything bigger is foreign.
 * Null for anything unreadable, non-JSON, a directory or a symlink.
 */
function readTreeJson(id: string, path: string): Record<string, unknown> | null {
  try {
    const file = resolveWritingTreePath(id, path), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WRITING_PAGE_BYTES + 64 * 1024) return null
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch { return null }
}

/** A page-file name that is free inside a folder: `<title>.json`, then `<title> 2.json`, … */
function uniquePageFileName(treeRoot: string, taken: Set<string>, parent: string, title: string): string {
  let candidate = pageFileName(title), attempt = 2
  while (taken.has(treeJoin(parent, candidate)) || existsSync(join(treeRoot, treeJoin(parent, candidate)))) candidate = pageFileName(`${title} ${attempt++}`)
  return candidate
}

/**
 * Match the metadata page list to the files on disk and repair both sides.
 * A listed path that exists wins; an unmatched .json file whose content carries
 * a missing page's id is adopted (the page was moved in Finder); legacy
 * `<uuid>.json` page files are renamed to `<title>.json` and lose the title
 * field from their content. Pages with no file anywhere are dropped. Returns
 * the surviving pages with their on-disk paths, mutating disk and metadata.
 */
function reconcileWritingPages(id: string, pages: { id: string; path: string }[]): { id: string; path: string }[] {
  const entries = scanWritingTree(id)
  const files = new Map(entries.filter(entry => !entry.directory).map(entry => [entry.path, entry]))
  const found = new Map<string, { id: string; path: string }>()
  for (const page of pages) if (files.has(page.path)) found.set(page.id, { ...page })
  // Orphan .json files are only read when a listed page's own file is missing:
  // an orphan whose content id matches adopts the page at its new home (a Finder move).
  if (pages.some(page => !found.has(page.id))) {
    const claimed = new Set([...found.values()].map(page => page.path))
    for (const path of files.keys()) {
      if (claimed.has(path) || !path.toLowerCase().endsWith('.json')) continue
      const content = readTreeJson(id, path)
      const contentId = typeof content?.id === 'string' ? content.id.toLowerCase() : ''
      const page = pages.find(candidate => !found.has(candidate.id) && candidate.id.toLowerCase() === contentId)
      if (page) { found.set(page.id, { id: page.id, path }); claimed.add(path) }
    }
  }
  const surviving: { id: string; path: string }[] = []
  const taken = new Set(entries.map(entry => entry.path))
  for (const page of pages) {
    const located = found.get(page.id)
    if (!located) continue
    let path = located.path
    // Only legacy <uuid>.json names need the content read: to rename the file to
    // the title it carries and to strip the stored title from the content.
    const legacy = LEGACY_PAGE_FILE.exec(treeName(path))
    if (legacy && legacy[1].toLowerCase() === page.id.toLowerCase()) {
      const file = resolveWritingTreePath(id, path), content = readTreeJson(id, path)
      if (content === null || typeof content.id !== 'string' || content.id.toLowerCase() !== page.id.toLowerCase()) continue
      let desired = 'Untitled page'
      try { desired = pageName(String(content.title ?? 'Untitled page')) } catch { /* An unusable legacy title falls back. */ }
      const parent = treeParent(path), renamed = uniquePageFileName(writingTreeRoot(id), taken, parent, desired)
      const target = treeJoin(parent, renamed)
      if (target !== path) { renameSync(file, resolveWritingTreePath(id, target)); taken.delete(path); taken.add(target); path = target }
      if ('title' in content) {
        const { title: _stored, ...rest } = content
        atomic(resolveWritingTreePath(id, path), rest)
      }
    }
    surviving.push({ id: page.id, path })
  }
  return surviving
}
/** Absolute paths of every page file, keyed by page id, from a repaired page list. */
function pageFilePaths(id: string, pages: { id: string; path: string }[]): Map<string, string> {
  return new Map(pages.map(page => [page.id, resolveWritingTreePath(id, page.path)]))
}
function requirePageFile(id: string, pageId: string): string {
  const notebook = getWritingNotebook(id), page = notebook.pages.find(entry => entry.id === uuid(pageId))
  if (!page) throw new Error('This page no longer exists in this notebook.')
  const file = resolveWritingTreePath(id, page.path)
  let stat
  try { stat = lstatSync(file) } catch { throw new Error('This page no longer exists in this notebook.') }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('This page no longer exists in this notebook.')
  return file
}
export function getWritingPage(id: string, pageId: string): WritingNotebookPage {
  const notebook = getWritingNotebook(id), entry = notebook.pages.find(page => page.id === pageId)
  if (!entry) throw new Error('This page no longer exists in this notebook.')
  const raw = JSON.parse(readFileSync(requirePageFile(id, pageId), 'utf8')) as WritingNotebookPage & { title?: unknown }
  if (raw.id !== pageId || typeof raw.markdown !== 'string' || !Number.isSafeInteger(raw.revision)) throw new Error('This page could not be read. Its file has been preserved.')
  const { title: _stored, ...page } = raw
  return page
}
function writeMetadata(notebook: WritingNotebook): void {
  const { associationAvailable: _available, tree: _tree, ...saved } = notebook
  atomic(join(writingNotebookDirectory(notebook.id), 'notebook.json'), saved)
}
function indexFingerprint(notebook: WritingNotebook): string {
  const paths = pageFilePaths(notebook.id, notebook.pages)
  return createHash('sha256').update(JSON.stringify([notebook.title, notebook.pages.map(p => [p.id, p.path, lstatSync(paths.get(p.id)!, { bigint: true }).mtimeNs.toString()])])).digest('hex')
}
function indexNotebook(id: string): void {
  const notebook = getWritingNotebook(id)
  const paths = pageFilePaths(id, notebook.pages)
  const previous = new Map((db().prepare('SELECT page_id,fingerprint FROM writing_notebook_page_index WHERE notebook_id=?').all(id) as { page_id: string; fingerprint: string }[]).map(row => [row.page_id, row.fingerprint]))
  const versions = notebook.pages.map(page => ({ page, fingerprint: JSON.stringify([notebook.title, pageTitle(page.path), lstatSync(paths.get(page.id)!, { bigint: true }).mtimeNs.toString()]) }))
  const changed = versions.filter(value => previous.get(value.page.id) !== value.fingerprint).map(value => ({ ...value, content: getWritingPage(id, value.page.id) }))
  tx(database => {
    const remove = database.prepare('DELETE FROM writing_notebook_search WHERE notebook_id=? AND page_id=?')
    const insert = database.prepare('INSERT INTO writing_notebook_search(notebook_id,page_id,title,page_title,content) VALUES(?,?,?,?,?)')
    const version = database.prepare('INSERT OR REPLACE INTO writing_notebook_page_index(notebook_id,page_id,fingerprint) VALUES(?,?,?)')
    for (const value of changed) { remove.run(id, value.page.id); insert.run(id, value.page.id, notebook.title, pageTitle(value.page.path), value.content.markdown); version.run(id, value.page.id, value.fingerprint) }
    for (const pageId of previous.keys()) if (!notebook.pages.some(page => page.id === pageId)) { remove.run(id, pageId); database.prepare('DELETE FROM writing_notebook_page_index WHERE notebook_id=? AND page_id=?').run(id, pageId) }
    database.prepare('INSERT OR REPLACE INTO writing_notebook_index(notebook_id,fingerprint) VALUES(?,?)').run(id, indexFingerprint(notebook))
  })
}

function changed(notebook: WritingNotebook): WritingNotebook {
  notebook.updatedAt = new Date().toISOString(); writeMetadata(notebook)
  indexNotebook(notebook.id); writingNotebookEvents.emit('changed', notebook.id)
  return getWritingNotebook(notebook.id)
}
let libraryWatch: { dir: string; watcher: FSWatcher } | null = null
let libraryNotice: ReturnType<typeof setTimeout> | null = null
const customWatches = new Map<string, { id: string; watcher: FSWatcher }>()
const customNotices = new Map<string, ReturnType<typeof setTimeout>>()
function noticeChanged(id: string): void {
  const previous = customNotices.get(id)
  if (previous) clearTimeout(previous)
  customNotices.set(id, setTimeout(() => { customNotices.delete(id); writingNotebookEvents.emit('changed', id) }, 200))
}
function watchLibrary(): void {
  const dir = root()
  mkdirSync(dir, { recursive: true })
  if (libraryWatch?.dir !== dir) {
    libraryWatch?.watcher.close()
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '')
      if (!name || name.includes('.tmp') || name.endsWith('.deleted')) return
      if (libraryNotice) clearTimeout(libraryNotice)
      libraryNotice = setTimeout(() => {
        libraryNotice = null
        const id = name.split(/[\\/]/)[0] ?? ''
        if (/^[0-9a-f-]{36}$/i.test(id)) writingNotebookEvents.emit('changed', id)
      }, 200)
    })
    watcher.unref()
    libraryWatch = { dir, watcher }
  }
  // Custom folders sit outside the library root, so each gets its own watcher.
  // Reconcile on every read: registrations, deletions, and user switches all land here.
  const locations = notebookLocations()
  for (const [directory, entry] of customWatches) if (locations[entry.id] !== directory) { entry.watcher.close(); customWatches.delete(directory) }
  for (const [id, directory] of Object.entries(locations)) {
    if (customWatches.has(directory) || !existsSync(directory)) continue
    try {
      const watcher = watch(directory, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '')
        if (!name || name.includes('.tmp') || name.endsWith('.deleted')) return
        noticeChanged(id)
      })
      watcher.on('error', () => { watcher.close(); customWatches.delete(directory) })
      watcher.unref()
      customWatches.set(directory, { id, watcher })
    } catch { /* The folder is unavailable; listing skips it until it returns. */ }
  }
}
export function listWritingNotebooks(): WritingNotebook[] {
  watchLibrary()
  const found = new Map<string, WritingNotebook>()
  if (existsSync(root())) for (const entry of readdirSync(root(), { withFileTypes: true })) {
    if (entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name)) found.set(entry.name, getWritingNotebook(entry.name))
  }
  // A custom folder that went missing stays registered, but lists nothing until it returns.
  for (const [id, directory] of Object.entries(notebookLocations())) {
    if (!found.has(id) && existsSync(join(directory, 'notebook.json'))) found.set(id, getWritingNotebook(id))
  }
  // Listings carry summaries; the tree belongs to the open notebook alone.
  for (const notebook of found.values()) delete notebook.tree
  return [...found.values()].sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt) || a.id.localeCompare(b.id))
}
export function createWritingNotebook(name: string, association?: NotebookAssociation, folder?: string | null): WritingNotebook {
  const custom = folder == null || folder === '' ? undefined : resolveNotebookFolder(folder)
  const id = randomUUID(), pageId = randomUUID(), at = new Date().toISOString()
  const directory = custom ?? join(root(), uuid(id))
  const treeRoot = join(directory, WRITING_TREE_DIR)
  mkdirSync(treeRoot, { recursive: true })
  // The page's file name is its title; a pre-existing file in a chosen folder forces a suffix.
  const taken = new Set(readdirSync(treeRoot).map(name => name))
  const path = uniquePageFileName(treeRoot, taken, '', 'Untitled page')
  const notebook: WritingNotebook = { id, version: 1, title: title(name), association: resolveNotebookAssociation(association), createdAt: at, updatedAt: at, lastAccessedAt: at,
    pages: [{ id: pageId, path }], selectedPageId: pageId, textScale: 1, chatOpen: false, showLineNumbers: false, textLayout: 'wide' }
  atomic(join(treeRoot, path), { id: pageId, revision: 0, markdown: '', updatedAt: at })
  if (custom) registerNotebookLocation(id, custom)
  return changed(notebook)
}
export function updateWritingNotebook(id: string, patch: Partial<Pick<WritingNotebook, 'selectedPageId' | 'textScale' | 'chatOpen' | 'bounds' | 'showLineNumbers' | 'textLayout'>>): WritingNotebook {
  const notebook = getWritingNotebook(id)
  if ('title' in patch) throw new Error('Notebook titles cannot be changed after creation.')
  if (patch.selectedPageId !== undefined) { if (!notebook.pages.some(p => p.id === patch.selectedPageId)) throw new Error('Unknown page.'); notebook.selectedPageId = patch.selectedPageId }
  if (patch.textScale !== undefined) { if (!Number.isFinite(patch.textScale) || patch.textScale < 0.5 || patch.textScale > 2) throw new Error('Invalid text size.'); notebook.textScale = patch.textScale }
  if (patch.chatOpen !== undefined) notebook.chatOpen = patch.chatOpen === true
  if (patch.showLineNumbers !== undefined) { if (typeof patch.showLineNumbers !== 'boolean') throw new Error('Invalid line number setting.'); notebook.showLineNumbers = patch.showLineNumbers }
  if (patch.textLayout !== undefined) { if (patch.textLayout !== 'wide' && patch.textLayout !== 'thin') throw new Error('Invalid text layout.'); notebook.textLayout = patch.textLayout }
  if (patch.bounds !== undefined) { if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(patch.bounds![key as keyof typeof patch.bounds]))) throw new Error('Invalid window bounds.'); notebook.bounds = patch.bounds }
  writeMetadata(notebook); return notebook
}
export function touchWritingNotebook(id: string): void {
  const notebook = getWritingNotebook(id); notebook.lastAccessedAt = new Date().toISOString(); writeMetadata(notebook); writingNotebookEvents.emit('changed', id)
}
export function saveWritingPage(id: string, pageId: string, revision: number, markdown: string): WritingNotebookSaveResult {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > MAX_WRITING_PAGE_BYTES) throw new Error('A page can contain up to 1 MiB of Markdown.')
  const page = getWritingPage(id, pageId)
  if (page.revision !== revision) return { ok: false, page }
  const saved: WritingNotebookPage = { id: page.id, markdown, revision: revision + 1, updatedAt: new Date().toISOString() }
  atomic(requirePageFile(id, pageId), saved)
  changed(getWritingNotebook(id)); return { ok: true, page: saved }
}
export function addWritingPage(id: string, name = 'Untitled page', folder = ''): WritingNotebook {
  const notebook = getWritingNotebook(id)
  if (notebook.pages.length >= MAX_WRITING_PAGES) throw new Error('A notebook supports up to 500 pages.')
  const parent = treePath(folder ?? '')
  const directory = parent ? resolveWritingTreePath(id, parent) : writingTreeRoot(id)
  if (parent && (!existsSync(directory) || !lstatSync(directory).isDirectory())) throw new Error('That folder no longer exists.')
  const taken = new Set(scanWritingTree(id).map(entry => entry.path))
  const file = uniquePageFileName(writingTreeRoot(id), taken, parent, pageName(name))
  const path = treeJoin(parent, file)
  const page: WritingNotebookPage = { id: randomUUID(), markdown: '', revision: 0, updatedAt: new Date().toISOString() }
  atomic(join(directory, file), page)
  notebook.pages.push({ id: page.id, path }); notebook.selectedPageId = page.id
  return changed(notebook)
}
/**
 * Rename a page: its file is renamed to the new title (made unique inside its
 * folder), and the metadata path follows. The page id and content are untouched.
 */
export function renameWritingPage(id: string, pageId: string, name: string): WritingNotebook {
  const notebook = getWritingNotebook(id), page = notebook.pages.find(page => page.id === pageId)
  if (!page) throw new Error('Unknown page.')
  const clean = pageName(name), parent = treeParent(page.path)
  const taken = new Set(scanWritingTree(id).map(entry => entry.path).filter(path => path !== page.path))
  const target = treeJoin(parent, uniquePageFileName(writingTreeRoot(id), taken, parent, clean))
  if (target !== page.path) {
    renameSync(requirePageFile(id, pageId), resolveWritingTreePath(id, target))
    page.path = target
  }
  return changed(notebook)
}
export function reorderWritingPages(id: string, ids: string[]): WritingNotebook {
  const notebook = getWritingNotebook(id)
  if (!Array.isArray(ids) || ids.length !== notebook.pages.length || new Set(ids).size !== ids.length || ids.some(id => !notebook.pages.some(p => p.id === id))) throw new Error('Invalid page order.')
  notebook.pages = ids.map(id => notebook.pages.find(p => p.id === id)!); return changed(notebook)
}
export function deleteWritingPage(id: string, pageId: string): WritingNotebook {
  const notebook = getWritingNotebook(id); const file = requirePageFile(id, pageId)
  if (notebook.pages.length === 1) throw new Error('Keep at least one page in a notebook.')
  notebook.pages = notebook.pages.filter(page => page.id !== pageId)
  if (notebook.selectedPageId === pageId) notebook.selectedPageId = notebook.pages[0]!.id
  const result = changed(notebook)
  rmSync(file, { force: true }); return result
}
/** The metadata page entry for a tree path, when the path is a listed page's file. */
function pageAtPath(notebook: WritingNotebook, path: string): { id: string; path: string } | undefined {
  return notebook.pages.find(page => page.path === path)
}
export function createWritingFolder(id: string, parent: string, name: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const clean = folderName(name), relative = treePath(parent ?? '')
  if (relative) {
    const directory = resolveWritingTreePath(id, relative)
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('That folder no longer exists.')
  }
  const target = treeJoin(relative, clean)
  treePath(target)
  const full = resolveWritingTreePath(id, target)
  if (existsSync(full)) throw new Error('Something with that name already exists in this folder.')
  mkdirSync(full)
  return changed(notebook)
}
/**
 * Create an empty file in a tree folder ('' is the root); the name carries
 * its own extension. A listed page's file name stays reserved, and the 'wx'
 * flag keeps the collision check race-safe.
 */
export function createWritingFile(id: string, folder: string, name: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const clean = fileName(name), relative = treePath(folder ?? '')
  if (relative) {
    const directory = resolveWritingTreePath(id, relative)
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('That folder no longer exists.')
  }
  const target = treePath(treeJoin(relative, clean))
  if (pageAtPath(notebook, target)) throw new Error('That name is reserved for a page file.')
  const full = resolveWritingTreePath(id, target)
  if (existsSync(full)) throw new Error('Something with that name already exists in this folder.')
  try { writeFileSync(full, '', { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Something with that name already exists in this folder.'); throw error }
  return changed(notebook)
}
export function deleteWritingFolder(id: string, path: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const relative = treePath(path)
  if (!relative) throw new Error('The notebook root cannot be deleted.')
  const full = resolveWritingTreePath(id, relative)
  if (!existsSync(full) || !lstatSync(full).isDirectory()) throw new Error('That folder no longer exists.')
  const doomed = new Set(notebook.pages.filter(page => page.path === relative || page.path.startsWith(relative + '/')).map(page => page.id))
  const remaining = notebook.pages.filter(page => !doomed.has(page.id))
  if (!remaining.length) throw new Error('Keep at least one page in a notebook.')
  notebook.pages = remaining
  if (!remaining.some(page => page.id === notebook.selectedPageId)) notebook.selectedPageId = remaining[0]!.id
  const result = changed(notebook)
  rmSync(full, { recursive: true, force: true }); return result
}
export function deleteWritingFile(id: string, path: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const relative = treePath(path)
  if (!relative) throw new Error('The notebook root cannot be deleted.')
  const full = resolveWritingTreePath(id, relative)
  let stat
  try { stat = lstatSync(full) } catch { throw new Error('That file no longer exists.') }
  if (!stat.isFile()) throw new Error('That item is not a file.')
  if (pageAtPath(notebook, relative)) throw new Error('Delete pages from their own context menu.')
  rmSync(full, { force: true })
  return changed(notebook)
}
export function moveWritingEntry(id: string, source: string, targetFolder: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const from = treePath(source)
  if (!from) throw new Error('The notebook root cannot be moved.')
  const to = treePath(targetFolder ?? '')
  const full = resolveWritingTreePath(id, from)
  let stat
  try { stat = lstatSync(full) } catch { throw new Error('That item no longer exists.') }
  const entries = scanWritingTree(id)
  if (stat.isDirectory()) {
    if (to === from || to.startsWith(from + '/')) throw new Error('A folder cannot be moved into itself.')
    const deepest = entries.reduce((depth, entry) => entry.path.startsWith(from + '/') ? Math.max(depth, treeDepth(entry.path)) : depth, treeDepth(from))
    if (treeDepth(to) + deepest - treeDepth(from) + 1 > MAX_WRITING_FOLDER_DEPTH) throw new Error(`Folders can nest up to ${MAX_WRITING_FOLDER_DEPTH} levels.`)
  }
  if (to) {
    const directory = resolveWritingTreePath(id, to)
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('The target folder no longer exists.')
  }
  const target = treeJoin(to, treeName(from))
  if (target === from) return notebook
  treePath(target)
  const moved = resolveWritingTreePath(id, target)
  if (existsSync(moved)) throw new Error('Something with that name already exists in the target folder.')
  renameSync(full, moved)
  // A moved page file (or a folder carrying pages) updates the metadata paths.
  for (const page of notebook.pages) {
    if (page.path === from) page.path = target
    else if (page.path.startsWith(from + '/')) page.path = target + page.path.slice(from.length)
  }
  return changed(notebook)
}
/**
 * Copy files dragged in from outside (Finder, browser downloads, screenshots)
 * into a tree folder ('' is the root). The preload resolves each dropped File
 * to an absolute path with webUtils.getPathForFile; those paths are validated
 * here, never trusted: regular files only, names the tree would actually show,
 * and every target checked before the first copy so a refused batch changes
 * nothing. Symlinks are followed, so the copy is always a real file.
 */
export function importWritingFiles(id: string, folder: string, paths: unknown): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const to = treePath(typeof folder === 'string' ? folder : '')
  if (to) {
    const directory = resolveWritingTreePath(id, to)
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('That folder no longer exists.')
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_WRITING_IMPORT_FILES) throw new Error(`Drop between one and ${MAX_WRITING_IMPORT_FILES} files.`)
  const plan: { source: string; target: string }[] = []
  const claimed = new Set<string>()
  for (const value of paths) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Drop files from Finder or another app.')
    let stat
    try { stat = statSync(value) } catch { throw new Error('A dropped file no longer exists.') }
    const name = basename(value)
    if (!stat.isFile()) throw new Error(`“${name}” is not a file.`)
    if (stat.size > MAX_WRITING_FILE_BYTES) throw new Error(`“${name}” is larger than ${MAX_WRITING_FILE_BYTES / 1024 / 1024} MiB.`)
    // The tree never shows dotfiles, transient writes or tombstones; refuse those names up front.
    if (name.startsWith('.') || name.includes('.tmp') || name.endsWith('.deleted')) throw new Error(`“${name}” cannot be added to a notebook.`)
    const relative = treePath(treeJoin(to, name))
    if (pageAtPath(notebook, relative)) throw new Error(`“${name}” is one of this notebook's pages; move it inside the notebook instead.`)
    if (claimed.has(relative)) throw new Error(`Two dropped files are both named “${name}".`)
    claimed.add(relative)
    const target = resolveWritingTreePath(id, relative)
    if (existsSync(target)) {
      // Dragging a notebook's own file onto its own folder is a no-op, not a collision.
      let same = false
      try { same = realpathSync(value) === realpathSync(target) } catch { same = false }
      if (same) continue
      throw new Error('Something with that name already exists in this folder.')
    }
    plan.push({ source: value, target })
  }
  for (const item of plan) copyFileSync(item.source, item.target)
  return plan.length ? changed(notebook) : notebook
}
/**
 * Rename a folder or a foreign file in place: the tree keeps its shape, only
 * the last path segment changes, so no depth or subtree rules apply. Pages are
 * renamed by title (renameWritingPage) — their file name carries the title.
 */
export function renameWritingEntry(id: string, path: string, name: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const from = treePath(path)
  if (!from) throw new Error('The notebook root cannot be renamed.')
  const full = resolveWritingTreePath(id, from)
  let stat
  try { stat = lstatSync(full) } catch { throw new Error('That item no longer exists.') }
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported in the notebook tree.')
  if (pageAtPath(notebook, from)) throw new Error('Rename pages by their title, not their file.')
  const clean = stat.isDirectory() ? folderName(name) : fileName(name)
  const to = treePath(treeJoin(treeParent(from), clean))
  if (to === from) return notebook
  const target = resolveWritingTreePath(id, to)
  if (pageAtPath(notebook, to)) throw new Error('That name is reserved for a page file.')
  if (existsSync(target)) throw new Error('Something with that name already exists in this folder.')
  renameSync(full, target)
  return changed(notebook)
}
/**
 * Resolve a non-page tree file for reading or writing: validated path, no
 * symlinks, and never a listed page's own file (pages open in the page
 * editor). Returns the absolute path and current size.
 */
function requireTreeFile(id: string, path: string): { file: string; bytes: number } {
  const notebook = getWritingNotebook(id)
  const relative = treePath(path)
  if (!relative) throw new Error('That item is not a file.')
  if (pageAtPath(notebook, relative)) throw new Error('Pages open in the page editor.')
  const file = resolveWritingTreePath(id, relative)
  let stat
  try { stat = lstatSync(file) } catch { throw new Error('That file no longer exists.') }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That item is not a file.')
  return { file, bytes: stat.size }
}
/**
 * Read a foreign file for the viewer. Images and videos never come through
 * here (the asset protocol serves them); anything else is offered as text
 * unless it sniffs binary, is not valid UTF-8, or is too large to edit.
 */
export function readWritingFile(id: string, path: string): WritingFileRead {
  const { file, bytes } = requireTreeFile(id, path)
  if (bytes > MAX_WRITING_TEXT_BYTES) return { kind: 'large', bytes }
  const buffer = readFileSync(file)
  const raw = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (looksBinary(raw) || !decodableAsUtf8(raw)) return { kind: 'binary', bytes }
  return { kind: 'text', text: buffer.toString('utf8'), bytes }
}
/** Overwrite a foreign file with edited text. Pages and oversized content are refused. */
export function saveWritingFile(id: string, path: string, text: string): WritingNotebook {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_WRITING_TEXT_BYTES) throw new Error(`A text file can hold up to ${MAX_WRITING_TEXT_BYTES / 1024 / 1024} MiB.`)
  const { file } = requireTreeFile(id, path)
  atomicText(file, text)
  writingNotebookEvents.emit('changed', id)
  return getWritingNotebook(id)
}
export function deleteWritingNotebook(id: string): void {
  getWritingNotebook(id); writingNotebookEvents.emit('removing', id)
  const directory = writingNotebookDirectory(id), custom = notebookLocations()[uuid(id)]
  if (custom) {
    // The folder belongs to the user: remove only what this notebook owns —
    // its whole page tree (the confirm dialog says files inside it go too),
    // assets and metadata. Anything else in the folder stays.
    rmSync(join(directory, WRITING_TREE_DIR), { recursive: true, force: true })
    rmSync(join(directory, 'assets'), { recursive: true, force: true })
    rmSync(join(directory, 'notebook.json'), { force: true })
    unregisterNotebookLocation(id)
  } else {
    // Rename first: a crash cannot resurrect a deleted notebook during index repair.
    const tombstone = `${directory}.deleted`
    renameSync(directory, tombstone)
    rmSync(tombstone, { recursive: true, force: true })
  }
  tx(database => { database.prepare('DELETE FROM writing_notebook_search WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_chats WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_index WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_page_index WHERE notebook_id=?').run(id) })
  writingNotebookEvents.emit('changed', id)
}
export function searchWritingNotebooks(query: string, association?: NotebookAssociation): WritingNotebookHit[] {
  if (typeof query !== 'string' || query.length > 300) throw new Error('Search accepts up to 300 characters.')
  const notebooks = listWritingNotebooks()
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const words = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? []
  if (!query.trim()) return notebooks.map(notebook => ({ notebook, rank: 0 }))
  if (!words.length) return []
  // Compare file versions, so interrupted writes repair only the affected index entries.
  const indexed = db().prepare('SELECT notebook_id,fingerprint FROM writing_notebook_index').all() as { notebook_id: string; fingerprint: string }[]
  const versions = new Map(indexed.map(row => [row.notebook_id, row.fingerprint]))
  for (const notebook of notebooks) if (versions.get(notebook.id) !== indexFingerprint(notebook)) indexNotebook(notebook.id)
  // A registered custom folder that is merely missing keeps its index and chats until it returns.
  const registered = notebookLocations()
  for (const row of indexed) if (!notebooks.some(n => n.id === row.notebook_id) && !registered[row.notebook_id]) tx(database => {
    database.prepare('DELETE FROM writing_notebook_search WHERE notebook_id=?').run(row.notebook_id)
    database.prepare('DELETE FROM writing_notebook_index WHERE notebook_id=?').run(row.notebook_id)
    database.prepare('DELETE FROM writing_notebook_page_index WHERE notebook_id=?').run(row.notebook_id)
    database.prepare('DELETE FROM writing_notebook_chats WHERE notebook_id=?').run(row.notebook_id)
  })
  const expression = words.map(word => `"${word}"*`).join(' AND ')
  const rows = db().prepare(`SELECT notebook_id,page_id,title,page_title,snippet(writing_notebook_search,4,'','','…',32) AS excerpt,bm25(writing_notebook_search,0,0,8,4,1) AS relevance FROM writing_notebook_search WHERE writing_notebook_search MATCH ? ORDER BY relevance`).all(expression) as { notebook_id: string; page_id: string; title: string; page_title: string; excerpt: string; relevance: number }[]
  const matches = (value: string) => words.every(word => normalize(value).includes(word))
  const byId = new Map(notebooks.map(n => [n.id, n]))
  const best = new Map<string, WritingNotebookHit & { relevance: number }>()
  for (const row of rows) {
    const notebook = byId.get(row.notebook_id)
    if (!notebook) continue
    const rank = matches(row.title) ? 0 : matches(row.page_title) ? 1 : 2
    const hit = { notebook, rank, relevance: row.relevance, pageId: row.page_id, pageTitle: row.page_title, excerpt: row.excerpt }
    const previous = best.get(notebook.id)
    if (!previous || rank < previous.rank || (rank === previous.rank && hit.relevance < previous.relevance)) best.set(notebook.id, hit)
  }
  const associated = (n: WritingNotebookHit) => Boolean(association && n.notebook.association?.kind === association.kind && n.notebook.association.id === association.id)
  return [...best.values()].sort((a, b) => a.rank - b.rank || Number(associated(b)) - Number(associated(a)) || a.relevance - b.relevance || b.notebook.lastAccessedAt.localeCompare(a.notebook.lastAccessedAt)).slice(0, 100)

}
export { writingNotebookAsset } from './writing-notebook-assets'
