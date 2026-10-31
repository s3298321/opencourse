import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_WRITING_PAGE_BYTES, MAX_WRITING_PAGES, type NotebookAssociation, type WritingNotebook, type WritingNotebookHit, type WritingNotebookPage, type WritingNotebookSaveResult } from '../core/writing-notebooks/types'
import { userWritingNotebooksDir } from './paths'
import { requireUser } from './users'
import { db, tx } from './db'
import { getCourse } from './courses'
import { getDocument } from './documents'
import { getProject } from './coach'

export const writingNotebookEvents = new EventEmitter()
const uuid = (value: string): string => { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid notebook identity.'); return value }
const root = () => userWritingNotebooksDir(requireUser())
export const writingNotebookDirectory = (id: string): string => join(root(), uuid(id))
function title(value: string): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('Use a title between 1 and 200 characters.'); return value.trim() }
function atomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, file) }
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
export function getWritingNotebook(id: string): WritingNotebook {
  const result = JSON.parse(readFileSync(join(writingNotebookDirectory(id), 'notebook.json'), 'utf8')) as WritingNotebook
  if (result.version !== 1 || result.id !== id || !Array.isArray(result.pages) || !result.pages.length) throw new Error('This notebook could not be read. Its files have been preserved.')
  result.pages.forEach(page => uuid(page.id))
  result.showLineNumbers = result.showLineNumbers === true
  result.textLayout = result.textLayout === 'thin' ? 'thin' : 'wide'
  if (result.association) { try { result.associationAvailable = !!resolveNotebookAssociation(result.association) } catch { result.associationAvailable = false } }
  return result
}
export function getWritingPage(id: string, pageId: string): WritingNotebookPage {
  const notebook = getWritingNotebook(id), entry = notebook.pages.find(page => page.id === pageId)
  if (!entry) throw new Error('This page no longer exists in this notebook.')
  const page = JSON.parse(readFileSync(join(writingNotebookDirectory(id), `${uuid(pageId)}.json`), 'utf8')) as WritingNotebookPage
  if (page.id !== pageId || typeof page.markdown !== 'string' || !Number.isSafeInteger(page.revision)) throw new Error('This page could not be read. Its file has been preserved.')
  return { ...page, title: entry.title }
}
function writeMetadata(notebook: WritingNotebook): void {
  const { associationAvailable: _available, ...saved } = notebook
  atomic(join(writingNotebookDirectory(notebook.id), 'notebook.json'), saved)
}
function indexFingerprint(notebook: WritingNotebook): string {
  return createHash('sha256').update(JSON.stringify([notebook.title, notebook.pages.map(p => [p.id, p.title, lstatSync(join(writingNotebookDirectory(notebook.id), `${p.id}.json`), { bigint: true }).mtimeNs.toString()])])).digest('hex')
}
function indexNotebook(id: string): void {
  const notebook = getWritingNotebook(id)
  const previous = new Map((db().prepare('SELECT page_id,fingerprint FROM writing_notebook_page_index WHERE notebook_id=?').all(id) as { page_id: string; fingerprint: string }[]).map(row => [row.page_id, row.fingerprint]))
  const versions = notebook.pages.map(page => ({ page, fingerprint: JSON.stringify([notebook.title, page.title, lstatSync(join(writingNotebookDirectory(id), `${page.id}.json`), { bigint: true }).mtimeNs.toString()]) }))
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
export function listWritingNotebooks(): WritingNotebook[] {
  if (!existsSync(root())) return []
  return readdirSync(root(), { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name)).map(entry => getWritingNotebook(entry.name))
    .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt) || a.id.localeCompare(b.id))
}
export function createWritingNotebook(name: string, association?: NotebookAssociation): WritingNotebook {
  const id = randomUUID(), pageId = randomUUID(), at = new Date().toISOString()
  const notebook: WritingNotebook = { id, version: 1, title: title(name), association: resolveNotebookAssociation(association), createdAt: at, updatedAt: at, lastAccessedAt: at,
    pages: [{ id: pageId, title: 'Untitled page' }], selectedPageId: pageId, textScale: 1, chatOpen: false, showLineNumbers: false, textLayout: 'wide' }
  mkdirSync(writingNotebookDirectory(id), { recursive: true })
  atomic(join(writingNotebookDirectory(id), `${pageId}.json`), { id: pageId, title: 'Untitled page', revision: 0, markdown: '', updatedAt: at })
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
  atomic(join(writingNotebookDirectory(id), `${pageId}.json`), saved)
  changed(getWritingNotebook(id)); return { ok: true, page: saved }
}
export function addWritingPage(id: string, name = 'Untitled page'): WritingNotebook {
  const notebook = getWritingNotebook(id)
  if (notebook.pages.length >= MAX_WRITING_PAGES) throw new Error('A notebook supports up to 500 pages.')
  const page: WritingNotebookPage = { id: randomUUID(), title: title(name), markdown: '', revision: 0, updatedAt: new Date().toISOString() }
  atomic(join(writingNotebookDirectory(id), `${page.id}.json`), page)
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
  const notebook = getWritingNotebook(id); getWritingPage(id, pageId)
  if (notebook.pages.length === 1) throw new Error('Keep at least one page in a notebook.')
  notebook.pages = notebook.pages.filter(page => page.id !== pageId)
  if (notebook.selectedPageId === pageId) notebook.selectedPageId = notebook.pages[0]!.id
  const result = changed(notebook)
  rmSync(join(writingNotebookDirectory(id), `${uuid(pageId)}.json`), { force: true }); return result
}
export function deleteWritingNotebook(id: string): void {
  getWritingNotebook(id); writingNotebookEvents.emit('removing', id)
  // Rename first: a crash cannot resurrect a deleted notebook during index repair.
  const tombstone = `${writingNotebookDirectory(id)}.deleted`
  renameSync(writingNotebookDirectory(id), tombstone)
  tx(database => { database.prepare('DELETE FROM writing_notebook_search WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_chats WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_index WHERE notebook_id=?').run(id); database.prepare('DELETE FROM writing_notebook_page_index WHERE notebook_id=?').run(id) })
  rmSync(tombstone, { recursive: true, force: true }); writingNotebookEvents.emit('changed', id)
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
  for (const row of indexed) if (!notebooks.some(n => n.id === row.notebook_id)) tx(database => {
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
