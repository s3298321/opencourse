import { app, BrowserWindow, dialog } from 'electron'
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { db, tx } from './db'
import { currentUserId, requireUser } from './users'
import { userDocumentsDir } from './paths'
import { DOCUMENT_INDEX_VERSION, MAX_PAGE_TEXT, MAX_PDF_RANGE, type DocumentImportResult, type DocumentSearch, type DocumentSection, type DocumentSummary, type DocumentView } from '../core/documents/types'
import { fullTextQuery } from '../core/documents/text'

export const documentEvents = new EventEmitter()
const workers = new Map<string, { worker: Worker; owner: string }>()
function summary(row: Record<string, unknown>): DocumentSummary {
  return { id: String(row.id), title: String(row.title_override ?? row.title), bytes: Number(row.bytes), fingerprint: String(row.fingerprint), pages: Number(row.pages), indexedPages: Number(row.indexed_pages), searchablePages: Number(row.searchable_pages), status: row.status === 'ready' ? 'ready' : row.status === 'error' ? 'error' : 'indexing', error: typeof row.error === 'string' ? row.error : null, completed: row.completed === 1, createdAt: String(row.created_at) }
}
function rowFor(id: string): Record<string, unknown> {
  if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.')
  const row = db().prepare('SELECT * FROM documents WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!row) throw new Error('This document is no longer in your library.')
  return row
}
export function documentFile(id: string): string {
  rowFor(id)
  return join(userDocumentsDir(requireUser()), `${id}.pdf`)
}
export function listDocuments(): DocumentSummary[] {
  const list = (db().prepare('SELECT * FROM documents ORDER BY created_at DESC,id DESC').all() as Record<string, unknown>[]).map(summary)
  for (const document of list) if (document.status === 'indexing') startDocumentIndex(document.id)
  return list
}
export function getDocument(id: string): DocumentView {
  const row = rowFor(id), document = summary(row)
  let sections: DocumentSection[] = []
  try { sections = JSON.parse(String(row.sections)) } catch { /* Recoverable cache. */ }
  if (document.status === 'indexing' || (document.status === 'ready' && row.index_version !== DOCUMENT_INDEX_VERSION)) startDocumentIndex(id)
  return { ...document, sections, lastPage: Number(row.last_page) }
}
export function stopDocumentWorkers(): void {
  for (const { worker } of workers.values()) void worker.terminate()
  workers.clear()
}
app.on('before-quit', stopDocumentWorkers)

export function startDocumentIndex(id: string, password?: string): void {
  if (workers.has(id)) return
  const row = rowFor(id), owner = requireUser(), path = documentFile(id)
  // Old extractor versions are rebuilt; interrupted indexes resume by replacing page rows.
  if (row.index_version !== DOCUMENT_INDEX_VERSION) tx(database => {
    database.prepare('DELETE FROM document_pages WHERE document_id=?').run(id)
    database.prepare("UPDATE documents SET indexed_pages=0,searchable_pages=0,sections='[]',index_version=? WHERE id=?").run(DOCUMENT_INDEX_VERSION, id)
  })
  db().prepare("UPDATE documents SET status='indexing',error=NULL WHERE id=?").run(id)
  const worker = new Worker(join(__dirname, 'document-worker.js'), { workerData: { path, password } })
  const entry = { worker, owner }
  workers.set(id, entry)
  const valid = (): boolean => workers.get(id) === entry && currentUserId() === owner && !!db().prepare('SELECT id FROM documents WHERE id=?').get(id)
  const changed = (): void => { documentEvents.emit('changed', id) }
  let sections: DocumentSection[] = [], finished = false
  const fail = (message: string): void => {
    if (!valid() || finished) return
    finished = true
    db().prepare("UPDATE documents SET status='error',error=? WHERE id=?").run(message.slice(0, 500), id)
    workers.delete(id); void worker.terminate(); changed()
  }
  worker.on('message', (message: { type: string; pages?: number; title?: string; sections?: DocumentSection[]; page?: number; text?: string; headings?: DocumentSection[]; message?: string; version?: number }) => {
    if (!valid()) { void worker.terminate(); return }
    try {
      if (message.type === 'metadata') {
        sections = message.sections ?? []
        db().prepare('UPDATE documents SET pages=?,title=COALESCE(?,title),sections=? WHERE id=?').run(message.pages!, message.title || null, JSON.stringify(sections), id)
        changed()
      } else if (message.type === 'page') {
        const text = (message.text ?? '').slice(0, MAX_PAGE_TEXT)
        sections = [...sections, ...(message.headings ?? [])].slice(0, 2000)
        tx(database => {
          const previous = database.prepare('SELECT length(text) AS chars FROM document_pages WHERE document_id=? AND page=?').get(id, message.page!) as { chars: number } | undefined
          database.prepare('DELETE FROM document_pages WHERE document_id=? AND page=?').run(id, message.page!)
          database.prepare('INSERT INTO document_pages(document_id,page,text) VALUES(?,?,?)').run(id, message.page!, text)
          database.prepare('INSERT INTO document_search(document_id,page,text) VALUES(?,?,?)').run(id, message.page!, text)
          database.prepare('UPDATE documents SET indexed_pages=indexed_pages+?,searchable_pages=searchable_pages+?,sections=? WHERE id=?').run(previous ? 0 : 1, (text.length ? 1 : 0) - (previous?.chars ? 1 : 0), JSON.stringify(sections), id)
        })
        worker.postMessage('next')
        if (message.page! % 10 === 0 || message.page === 1) changed()
      } else if (message.type === 'done') {
        finished = true
        db().prepare("UPDATE documents SET status='ready',error=NULL,index_version=? WHERE id=?").run(message.version!, id)
        workers.delete(id); changed()
      } else if (message.type === 'error') fail(message.message ?? 'PDF indexing failed.')
    } catch (error) { fail((error as Error).message) }
  })
  worker.on('error', error => fail(`PDF indexing failed: ${error.message}`))
  worker.on('exit', code => { if (!finished) fail(`PDF indexing stopped (${code}). Reopen or retry this document.`) })
}

export async function importDocument(path?: string): Promise<DocumentImportResult> {
  const owner = requireUser()
  if (!path) {
    const options = { properties: ['openFile'] as ('openFile')[], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] }
    const window = BrowserWindow.getFocusedWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' }
    path = result.filePaths[0]
  }
  if (currentUserId() !== owner) throw new Error('The local user changed.')
  const info = await stat(path)
  if (!info.isFile() || info.size < 5 || info.size > 1024 ** 3) throw new Error('Choose a PDF file smaller than 1 GiB.')
  const header = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(Math.min(1024, info.size)); await header.read(bytes, 0, bytes.length, 0)
    if (!bytes.includes(Buffer.from('%PDF-'))) throw new Error('This file is not a PDF document.')
  } finally { await header.close() }
  const root = userDocumentsDir(owner), id = randomUUID(), temporary = join(root, `${id}.importing`), destination = join(root, `${id}.pdf`)
  await mkdir(root, { recursive: true })
  try {
    await copyFile(path, temporary)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(temporary)) hash.update(chunk)
    const fingerprint = hash.digest('hex')
    if (currentUserId() !== owner) throw new Error('The local user changed.')
    const existing = db().prepare('SELECT * FROM documents WHERE fingerprint=?').get(fingerprint) as Record<string, unknown> | undefined
    if (existing) return { status: 'ok', document: summary(existing), duplicate: true }
    await rename(temporary, destination)
    if (currentUserId() !== owner) throw new Error('The local user changed.')
    db().prepare('INSERT INTO documents(id,title,bytes,fingerprint,created_at) VALUES(?,?,?,?,?)').run(id, basename(path).replace(/\.pdf$/i, '').slice(0, 300), info.size, fingerprint, new Date().toISOString())
    try { startDocumentIndex(id) }
    catch (error) { db().prepare("UPDATE documents SET status='error',error=? WHERE id=?").run(`PDF indexing failed: ${(error as Error).message}`.slice(0, 500), id) }
    documentEvents.emit('changed', id)
    return { status: 'ok', document: summary(rowFor(id)), duplicate: false }
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  } finally { await rm(temporary, { force: true }) }
}
export async function readDocumentRange(id: string, begin: number, end: number): Promise<Uint8Array> {
  const owner = requireUser(), document = summary(rowFor(id))
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > document.bytes || end - begin > MAX_PDF_RANGE) throw new Error('Invalid PDF byte range.')
  const file = await open(documentFile(id), 'r')
  try {
    const buffer = new Uint8Array(end - begin), { bytesRead } = await file.read(buffer, 0, buffer.length, begin)
    if (currentUserId() !== owner) throw new Error('The local user changed.')
    rowFor(id)
    if (bytesRead !== buffer.length) throw new Error('The PDF ended unexpectedly.')
    return buffer
  } finally { await file.close() }
}
export async function retryDocumentIndex(id: string, password?: string): Promise<void> {
  rowFor(id)
  const owner = requireUser(), entry = workers.get(id)
  if (entry) { workers.delete(id); await entry.worker.terminate() }
  if (currentUserId() !== owner) throw new Error('The local user changed.')
  startDocumentIndex(id, password)
  documentEvents.emit('changed', id)
}
export function renameDocument(id: string, title: string): DocumentView {
  rowFor(id)
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name || name.length > 300) throw new Error('Enter a document title between 1 and 300 characters.')
  db().prepare('UPDATE documents SET title_override=? WHERE id=?').run(name, id)
  documentEvents.emit('changed', id)
  return getDocument(id)
}
export function setDocumentCompleted(id: string, completed: boolean): DocumentView {
  rowFor(id)
  db().prepare('UPDATE documents SET completed=? WHERE id=?').run(completed === true ? 1 : 0, id)
  documentEvents.emit('changed', id)
  return getDocument(id)
}
export function setDocumentPage(id: string, page: number): void {
  const document = summary(rowFor(id))
  if (!Number.isSafeInteger(page) || page < 1 || (document.pages > 0 && page > document.pages)) throw new Error('That page is not in this document.')
  db().prepare('UPDATE documents SET last_page=? WHERE id=?').run(page, id)
}
export async function removeDocument(id: string): Promise<void> {
  const owner = requireUser(), path = documentFile(id)
  documentEvents.emit('removing', id)
  const entry = workers.get(id); workers.delete(id)
  if (entry) await entry.worker.terminate()
  await rm(path, { force: true })
  if (currentUserId() !== owner) return
  db().prepare('DELETE FROM documents WHERE id=?').run(id)
  documentEvents.emit('changed', id)
}
export function documentPageText(id: string, page: number): string | null {
  const document = summary(rowFor(id))
  if (!Number.isSafeInteger(page) || page < 1 || page > document.pages) throw new Error('That page is not in this document.')
  const row = db().prepare('SELECT text FROM document_pages WHERE document_id=? AND page=?').get(id, page) as { text: string } | undefined
  return row?.text ?? null
}
export function searchDocument(id: string, query: string, cursor = 0): DocumentSearch {
  const document = summary(rowFor(id)), match = typeof query === 'string' ? fullTextQuery(query) : null
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid search offset.')
  const rows = match ? db().prepare("SELECT page,snippet(document_search,2,'','',' … ',40) AS excerpt FROM document_search WHERE document_search MATCH ? AND document_id=? ORDER BY rank,page LIMIT 11 OFFSET ?").all(match, id, cursor) as { page: number; excerpt: string }[] : []
  return { hits: rows.slice(0, 10).map(row => ({ page: Number(row.page), excerpt: row.excerpt.slice(0, 800) })), more: rows.length > 10, indexedPages: document.indexedPages, pages: document.pages, complete: document.status === 'ready' }
}
