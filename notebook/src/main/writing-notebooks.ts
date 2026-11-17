import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { MAX_WRITING_PAGE_BYTES, MAX_WRITING_PAGES, type NotebookAssociation, type WritingNotebook, type WritingNotebookHit, type WritingNotebookPage, type WritingNotebookSaveResult } from '../core/writing-notebooks/types'
import { buildWritingTree, folderName, pageFileId, treeDepth, treeJoin, treeName, treePath, MAX_WRITING_FOLDER_DEPTH, WRITING_TREE_DIR } from '../core/writing-notebooks/tree'
import { isStandaloneNotebook } from '../core/writing-notebooks/standalone'
import { userWritingNotebooksDir } from './paths'
import { requireUser } from './users'
import { db, tx } from './db'
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
export function resolveNotebookAssociation(value?: NotebookAssociation): NotebookAssociation | undefined {
  if (value) throw new Error('Notebooks in OpenCourse Notebook are not tied to a course or document.')
  return undefined
}
export function getWritingNotebook(id: string): WritingNotebook {
  const metadata = join(writingNotebookDirectory(id), 'notebook.json')
  if (!existsSync(metadata)) throw new Error('This notebook is unavailable. Its folder may have been moved or deleted.')
  const result = JSON.parse(readFileSync(metadata, 'utf8')) as WritingNotebook
  if (result.version !== 1 || result.id !== id || !Array.isArray(result.pages) || !result.pages.length) throw new Error('This notebook could not be read. Its files have been preserved.')
  result.pages.forEach(page => uuid(page.id))
  result.showLineNumbers = result.showLineNumbers === true
  result.textLayout = result.textLayout === 'thin' ? 'thin' : 'wide'
  if (result.association) result.associationAvailable = false
  migrateWritingTree(id, result.pages.map(page => page.id))
  const entries = scanWritingTree(id)
  // The disk owns the hierarchy: a page whose file vanished (deleted in Finder,
  // say) leaves the metadata instead of stranding a broken row.
  const present = new Set(entries.filter(entry => !entry.directory).map(entry => pageFileId(treeName(entry.path))).filter((pageId): pageId is string => pageId !== null))
  const pages = result.pages.filter(page => present.has(page.id))
  if (!pages.length) throw new Error('This notebook could not be read. Its files have been preserved.')
  if (pages.length !== result.pages.length) {
    result.pages = pages
    if (!pages.some(page => page.id === result.selectedPageId)) result.selectedPageId = pages[0]!.id
    writeMetadata(result)
  }
  result.tree = buildWritingTree(entries, result.pages)
  return result
}
/** Absolute paths of every page file on disk, keyed by page id. The scan skips symlinks. */
function pageFilePaths(id: string): Map<string, string> {
  const root = writingTreeRoot(id), paths = new Map<string, string>()
  for (const entry of scanWritingTree(id)) {
    if (entry.directory) continue
    const pageId = pageFileId(treeName(entry.path))
    if (pageId !== null) paths.set(pageId, join(root, entry.path))
  }
  return paths
}
function requirePageFile(id: string, pageId: string): string {
  const file = pageFilePaths(id).get(uuid(pageId))
  if (!file) throw new Error('This page no longer exists in this notebook.')
  return file
}
export function getWritingPage(id: string, pageId: string): WritingNotebookPage {
  const notebook = getWritingNotebook(id), entry = notebook.pages.find(page => page.id === pageId)
  if (!entry) throw new Error('This page no longer exists in this notebook.')
  const page = JSON.parse(readFileSync(requirePageFile(id, pageId), 'utf8')) as WritingNotebookPage
  if (page.id !== pageId || typeof page.markdown !== 'string' || !Number.isSafeInteger(page.revision)) throw new Error('This page could not be read. Its file has been preserved.')
  return { ...page, title: entry.title }
}
function writeMetadata(notebook: WritingNotebook): void {
  const { associationAvailable: _available, tree: _tree, ...saved } = notebook
  atomic(join(writingNotebookDirectory(notebook.id), 'notebook.json'), saved)
}
function indexFingerprint(notebook: WritingNotebook): string {
  const paths = pageFilePaths(notebook.id)
  return createHash('sha256').update(JSON.stringify([notebook.title, notebook.pages.map(p => [p.id, p.title, lstatSync(paths.get(p.id)!, { bigint: true }).mtimeNs.toString()])])).digest('hex')
}
function indexNotebook(id: string): void {
  const notebook = getWritingNotebook(id)
  const paths = pageFilePaths(id)
  const previous = new Map((db().prepare('SELECT page_id,fingerprint FROM writing_notebook_page_index WHERE notebook_id=?').all(id) as { page_id: string; fingerprint: string }[]).map(row => [row.page_id, row.fingerprint]))
  const versions = notebook.pages.map(page => ({ page, fingerprint: JSON.stringify([notebook.title, page.title, lstatSync(paths.get(page.id)!, { bigint: true }).mtimeNs.toString()]) }))
  const changed = versions.filter(value => previous.get(value.page.id) !== value.fingerprint).map(value => ({ ...value, content: getWritingPage(id, value.page.id) }))
  tx(database => {
    const remove = database.prepare('DELETE FROM writing_notebook_search WHERE notebook_id=? AND page_id=?')
    const insert = database.prepare('INSERT INTO writing_notebook_search(notebook_id,page_id,title,page_title,content) VALUES(?,?,?,?,?)')
    const version = database.prepare('INSERT OR REPLACE INTO writing_notebook_page_index(notebook_id,page_id,fingerprint) VALUES(?,?,?)')
    for (const value of changed) { remove.run(id, value.page.id); insert.run(id, value.page.id, notebook.title, value.page.title, value.content.markdown); version.run(id, value.page.id, value.fingerprint) }
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
function readNotebooks(): WritingNotebook[] {
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
export function listWritingNotebooks(): WritingNotebook[] {
  return readNotebooks().filter(isStandaloneNotebook)
}
export function createWritingNotebook(name: string, association?: NotebookAssociation, folder?: string | null): WritingNotebook {
  if (association) throw new Error('Notebooks in OpenCourse Notebook are not tied to a course or document.')
  const custom = folder == null || folder === '' ? undefined : resolveNotebookFolder(folder)
  const id = randomUUID(), pageId = randomUUID(), at = new Date().toISOString()
  const notebook: WritingNotebook = { id, version: 1, title: title(name), createdAt: at, updatedAt: at, lastAccessedAt: at,
    pages: [{ id: pageId, title: 'Untitled page' }], selectedPageId: pageId, textScale: 1, chatOpen: false, showLineNumbers: false, textLayout: 'wide' }
  const directory = custom ?? join(root(), uuid(id))
  mkdirSync(join(directory, WRITING_TREE_DIR), { recursive: true })
  atomic(join(directory, WRITING_TREE_DIR, `${pageId}.json`), { id: pageId, title: 'Untitled page', revision: 0, markdown: '', updatedAt: at })
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
  const saved = { ...page, markdown, revision: revision + 1, updatedAt: new Date().toISOString() }
  atomic(requirePageFile(id, pageId), saved)
  changed(getWritingNotebook(id)); return { ok: true, page: saved }
}
export function addWritingPage(id: string, name = 'Untitled page', folder = ''): WritingNotebook {
  const notebook = getWritingNotebook(id)
  if (notebook.pages.length >= MAX_WRITING_PAGES) throw new Error('A notebook supports up to 500 pages.')
  const parent = treePath(folder ?? '')
  const directory = parent ? resolveWritingTreePath(id, parent) : writingTreeRoot(id)
  if (parent && (!existsSync(directory) || !lstatSync(directory).isDirectory())) throw new Error('That folder no longer exists.')
  const page: WritingNotebookPage = { id: randomUUID(), title: title(name), markdown: '', revision: 0, updatedAt: new Date().toISOString() }
  atomic(join(directory, `${page.id}.json`), page)
  notebook.pages.push({ id: page.id, title: page.title }); notebook.selectedPageId = page.id
  return changed(notebook)
}
export function renameWritingPage(id: string, pageId: string, name: string): WritingNotebook {
  const notebook = getWritingNotebook(id), page = notebook.pages.find(page => page.id === pageId)
  if (!page) throw new Error('Unknown page.'); page.title = title(name); return changed(notebook)
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
export function deleteWritingFolder(id: string, path: string): WritingNotebook {
  const notebook = getWritingNotebook(id)
  const relative = treePath(path)
  if (!relative) throw new Error('The notebook root cannot be deleted.')
  const full = resolveWritingTreePath(id, relative)
  if (!existsSync(full) || !lstatSync(full).isDirectory()) throw new Error('That folder no longer exists.')
  const doomed = new Set<string>()
  for (const entry of scanWritingTree(id)) {
    if (entry.directory || (entry.path !== relative && !entry.path.startsWith(relative + '/'))) continue
    const pageId = pageFileId(treeName(entry.path))
    if (pageId !== null) doomed.add(pageId)
  }
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
  const pageId = pageFileId(treeName(relative))
  if (pageId !== null && notebook.pages.some(page => page.id === pageId)) throw new Error('Delete pages from their own context menu.')
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
  return changed(notebook)
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
  const notebooks = readNotebooks()
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
  return [...best.values()].filter(hit => isStandaloneNotebook(hit.notebook)).sort((a, b) => a.rank - b.rank || Number(associated(b)) - Number(associated(a)) || a.relevance - b.relevance || b.notebook.lastAccessedAt.localeCompare(a.notebook.lastAccessedAt)).slice(0, 100)

}
export { writingNotebookAsset } from './writing-notebook-assets'
