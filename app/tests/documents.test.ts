import type { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixturePdf } from './helpers/pdf'
import type { ChatStreamOptions } from '../src/main/openai'
import { DOCUMENT_TOOLS, MAX_TURN_RETRIEVAL_CHARS } from '../src/core/reading/tools'
import { pageHeadings, pageText } from '../src/core/documents/text'

const root = mkdtempSync(join(tmpdir(), 'opencourse-documents-test-'))
let data = join(root, 'data')
const jobs: EventEmitter[] = []
const aiMock = vi.hoisted(() => ({ stream: vi.fn(), key: 'sk-local-test' }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => aiMock.key }))
vi.mock('../src/main/subscription', () => ({ subscriptionIdentity: () => null, subscriptionAccessToken: vi.fn() }))
vi.mock('../src/main/chattitles', () => ({ cancelChatTitles: vi.fn(), generateChatTitle: vi.fn() }))
vi.mock('../src/main/openai', async importOriginal => ({ ...await importOriginal<object>(), streamChat: (options: ChatStreamOptions) => aiMock.stream(options) }))
vi.mock('electron', () => ({ app: { getPath: () => data, on: () => {}, getAppPath: () => root }, BrowserWindow: { getFocusedWindow: () => null }, dialog: { showOpenDialog: async () => ({ canceled: true }) } }))
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  const { EventEmitter } = await import('node:events')
  class Worker extends EventEmitter {
  constructor() { super(); jobs.push(this) }
  postMessage() {}
  async terminate() { return 0 }
} return { ...actual, Worker, default: { ...actual, Worker } } })
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db, SCHEMA_VERSION } = await import('../src/main/db')
const { documentFile, documentPageText, getDocument, importDocument, listDocuments, readDocumentRange, removeDocument, renameDocument, retryDocumentIndex, searchDocument, setDocumentPage, setDocumentProgress, stopDocumentWorkers } = await import('../src/main/documents')
const { appendDocumentMessage, insertDocumentChat, selectDocumentChat, selectDocumentChats, selectDocumentMessages, configureDocumentChat } = await import('../src/main/document-chatdb')
const { runDocumentReadingTool } = await import('../src/main/document-reading')
const { buildInput } = await import('../src/core/sidechat/thread')
const chat = await import('../src/main/document-chat')
const { newAIConversation } = await import('../src/main/ai')
const { readPdfResource } = await import('../src/main/pdf-resources')
let fixture: string, n = 0
beforeEach(() => {
  chat.cancelAllDocumentChats(); stopDocumentWorkers(); closeDb(); jobs.length = 0
  aiMock.key = 'sk-local-test'; aiMock.stream.mockReset()
  data = join(root, `data-${++n}`); createUser('Reader')
  fixture = join(root, `original-${n}.pdf`); writeFileSync(fixture, fixturePdf())
})
afterAll(() => { chat.cancelAllDocumentChats(); stopDocumentWorkers(); closeDb(); rmSync(root, { recursive: true, force: true }) })
async function imported() {
  const result = await importDocument(fixture)
  if (result.status !== 'ok') throw new Error('Fixture was not imported')
  return result.document
}
function indexed(pages: string[]) {
  const worker = jobs.at(-1)!
  worker.emit('message', { type: 'metadata', pages: pages.length, sections: [{ id: 'chapter', title: 'Main heading', page: 1, depth: 0 }] })
  pages.forEach((text, index) => worker.emit('message', { type: 'page', page: index + 1, text, headings: [] }))
  worker.emit('message', { type: 'done', version: 1 })
}
describe('local PDF library', () => {
  it('lists the last message date separately from context and chat settings', async () => {
    const document = await imported()
    const summary = chat.createDocumentChat(document.id, 1)
    expect(summary.lastMessageAt).toBeNull()
    appendDocumentMessage(summary.id, { role: 'user', text: 'Explain this', at: '2026-10-05T10:00:00Z' })
    const at = '2026-10-05T10:01:00Z'
    appendDocumentMessage(summary.id, { role: 'assistant', text: 'Explanation', at })
    appendDocumentMessage(summary.id, { role: 'context', text: 'Another page', at: '2026-10-06T10:00:00Z' })
    configureDocumentChat(summary.id, 'gpt-5.1', null, 'apiKey')
    closeDb()
    expect(selectDocumentChat(summary.id)).toMatchObject({ lastMessageAt: at, messages: 2 })
    expect(selectDocumentChats(document.id)[0].lastMessageAt).toBe(at)
  })

  it('remembers each document’s page across reopen, indexing and user switches', async () => {
    const document = await imported()
    expect(getDocument(document.id).lastPage).toBe(1)
    // Reading works before the text index knows the PDF page count.
    setDocumentPage(document.id, 2)
    indexed(['First page', 'Second page', 'Third page'])
    closeDb()
    expect(getDocument(document.id).lastPage).toBe(2)
    expect(getDocument(document.id).readPage).toBe(0)
    await retryDocumentIndex(document.id)
    indexed(['First page', 'Second page', 'Third page'])
    expect(getDocument(document.id).lastPage).toBe(2)
    await importDocument(fixture)
    expect(getDocument(document.id).lastPage).toBe(2)
    const first = (await import('../src/main/users')).getSession().user!
    createUser('Another reader')
    expect(() => setDocumentPage(document.id, 1)).toThrow('no longer')
    const other = await imported()
    expect(getDocument(other.id).lastPage).toBe(1)
    switchUser(first.id)
    expect(getDocument(document.id).lastPage).toBe(2)
    for (const page of [0, -1, 1.5, NaN, Infinity, 4]) expect(() => setDocumentPage(document.id, page)).toThrow('page')
    expect(getDocument(document.id).lastPage).toBe(2)
  })
  it('defaults existing documents to page one when upgrading a version 16 library', async () => {
    const document = await imported(); indexed(['A passage'])
    renameDocument(document.id, 'Saved title')
    db().exec('ALTER TABLE documents DROP COLUMN last_page; PRAGMA user_version=16')
    closeDb()
    expect(getDocument(document.id)).toMatchObject({ title: 'Saved title', readPage: 0, lastPage: 1 })
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
  it('persists explicit progress independently of navigation, indexing and other users', async () => {
    const document = await imported()
    expect(getDocument(document.id).readPage).toBe(0)
    // The PDF may be readable before its text index knows the page count.
    expect(setDocumentProgress(document.id, 2).readPage).toBe(2)
    indexed(['One', 'Two', 'Three'])
    setDocumentPage(document.id, 3)
    closeDb()
    expect(getDocument(document.id)).toMatchObject({ readPage: 2, lastPage: 3 })
    await retryDocumentIndex(document.id)
    indexed(['One', 'Two', 'Three'])
    await importDocument(fixture)
    expect(getDocument(document.id).readPage).toBe(2)
    expect(setDocumentProgress(document.id, 1).readPage).toBe(1)
    expect(setDocumentProgress(document.id, 3).readPage).toBe(3)
    for (const page of [0, -1, 1.5, NaN, Infinity, 4, 100_001]) expect(() => setDocumentProgress(document.id, page)).toThrow('page')
    expect(getDocument(document.id).readPage).toBe(3)
    const first = (await import('../src/main/users')).getSession().user!
    createUser('Another reader')
    expect(() => setDocumentProgress(document.id, 1)).toThrow('no longer')
    const other = await imported()
    expect(getDocument(other.id).readPage).toBe(0)
    switchUser(first.id)
    expect(getDocument(document.id).readPage).toBe(3)
  })
  it('starts progress at zero when upgrading an existing library without inferring reading from navigation', async () => {
    const document = await imported(); indexed(['One', 'Two', 'Three'])
    setDocumentPage(document.id, 3)
    db().exec('ALTER TABLE documents DROP COLUMN read_page; PRAGMA user_version=20')
    closeDb()
    expect(getDocument(document.id)).toMatchObject({ readPage: 0, lastPage: 3 })
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
  it('retires the old completion flag while preserving marked progress and library summaries', async () => {
    const document = await imported(); indexed(['One', 'Two', 'Three'])
    setDocumentProgress(document.id, 1); setDocumentPage(document.id, 2)
    db().exec('ALTER TABLE documents ADD COLUMN completed INTEGER NOT NULL DEFAULT 1; PRAGMA user_version=21')
    closeDb()
    expect(getDocument(document.id)).toMatchObject({ readPage: 1, lastPage: 2, pages: 3 })
    expect(getDocument(document.id)).not.toHaveProperty('completed')
    expect(listDocuments()[0]).toMatchObject({ id: document.id, readPage: 1 })
    expect(db().prepare('PRAGMA table_info(documents)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'completed' })]))
    setDocumentProgress(document.id, 3)
    expect(listDocuments()[0]).toMatchObject({ readPage: 3, pages: 3 })
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
  it('keeps a renamed title across indexing, reopen and duplicate import without modifying the PDF', async () => {
    const document = await imported(), original = readFileSync(documentFile(document.id))
    expect(renameDocument(document.id, '  Natural pedagogy  ').title).toBe('Natural pedagogy')
    jobs.at(-1)!.emit('message', { type: 'metadata', pages: 1, title: 'untitled', sections: [] })
    indexed(['A passage'])
    expect(getDocument(document.id).title).toBe('Natural pedagogy')
    await retryDocumentIndex(document.id)
    jobs.at(-1)!.emit('message', { type: 'metadata', pages: 1, title: 'Incorrect metadata', sections: [] })
    indexed(['A passage'])
    closeDb()
    expect(listDocuments()[0]?.title).toBe('Natural pedagogy')
    expect(await importDocument(fixture)).toMatchObject({ status: 'ok', duplicate: true, document: { title: 'Natural pedagogy' } })
    expect(readFileSync(documentFile(document.id))).toEqual(original)
    expect(readFileSync(fixture)).toEqual(original)
    expect(() => renameDocument(document.id, '   ')).toThrow('title')
    expect(() => renameDocument(document.id, 'x'.repeat(301))).toThrow('title')
    expect(getDocument(document.id).title).toBe('Natural pedagogy')
    createUser('Another reader')
    expect(() => renameDocument(document.id, 'Not my document')).toThrow('no longer')
  })
  it('adds title overrides to an existing version 14 library without changing its title', async () => {
    const document = await imported(); indexed(['A passage'])
    db().exec('ALTER TABLE documents DROP COLUMN title_override; PRAGMA user_version=14')
    closeDb()
    expect(getDocument(document.id).title).toBe(document.title)
    expect(renameDocument(document.id, 'My title').title).toBe('My title')
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
  it('copies PDFs, deduplicates by contents, and removes only the local copy and dependent data', async () => {
    const document = await imported()
    expect(readFileSync(documentFile(document.id))).toEqual(readFileSync(fixture))
    const duplicate = await importDocument(fixture)
    expect(duplicate).toMatchObject({ status: 'ok', duplicate: true, document: { id: document.id } })
    expect(listDocuments()).toHaveLength(1)
    indexed(['Searchable material', 'The second page'])
    insertDocumentChat({ id: 'chat', documentId: document.id, startedOn: 1, model: 'gpt-5.6-terra', reasoning: null, provider: 'apiKey', title: '', messages: 0, createdAt: 'now', updatedAt: 'now' })
    appendDocumentMessage('chat', { role: 'user', text: 'Why?', at: 'now' })
    const copy = documentFile(document.id)
    await removeDocument(document.id)
    expect(existsSync(copy)).toBe(false); expect(existsSync(fixture)).toBe(true)
    expect(selectDocumentChats(document.id)).toEqual([])
    expect(db().prepare('SELECT * FROM document_pages').all()).toEqual([])
    expect(db().prepare('SELECT * FROM document_search').all()).toEqual([])
  })
  it('isolates files, chats and retrieval by user without changing reading progress', async () => {
    const document = await imported(); indexed(['Private page'])
    const before = getDocument(document.id)
    expect(documentPageText(document.id, 1)).toBe('Private page')
    expect(getDocument(document.id)).toEqual(before)
    const first = (await import('../src/main/users')).getSession().user!
    createUser('Another reader')
    expect(listDocuments()).toEqual([])
    expect(() => searchDocument(document.id, 'Private')).toThrow('no longer')
    await expect(readDocumentRange(document.id, 0, 5)).rejects.toThrow('no longer')
    switchUser(first.id)
    expect(getDocument(document.id).readPage).toBe(0)
  })
  it('bounds local byte reads and rejects paths, non-PDFs and invalid ranges', async () => {
    const document = await imported()
    expect(Buffer.from(await readDocumentRange(document.id, 0, 5)).toString()).toBe('%PDF-')
    await expect(readDocumentRange('../other-user', 0, 5)).rejects.toThrow('Invalid document ID')
    await expect(readDocumentRange(document.id, -1, 5)).rejects.toThrow('Invalid PDF byte range')
    await expect(readDocumentRange(document.id, 0, document.bytes + 1)).rejects.toThrow('Invalid PDF byte range')
    const invalid = join(root, 'invalid.pdf'); writeFileSync(invalid, 'this is not a PDF')
    await expect(importDocument(invalid)).rejects.toThrow('not a PDF')
    expect(listDocuments()).toHaveLength(1)
    expect(await importDocument()).toEqual({ status: 'cancelled' })
  })
  it('reports partial indexing, safely handles FTS punctuation, and exposes page-backed results', async () => {
    const document = await imported(), worker = jobs.at(-1)!
    worker.emit('message', { type: 'metadata', pages: 3, sections: [] })
    worker.emit('message', { type: 'page', page: 1, text: 'A needle appears here.', headings: [] })
    const partial = searchDocument(document.id, 'needle')
    expect(partial).toMatchObject({ complete: false, indexedPages: 1, pages: 3, hits: [{ page: 1 }] })
    expect(() => searchDocument(document.id, '" OR * (')).not.toThrow()
    expect(documentPageText(document.id, 2)).toBeNull()
    indexed(['A needle appears here.', '', 'Second needle passage'])
    expect(searchDocument(document.id, 'needle').complete).toBe(true)
    expect(searchDocument(document.id, 'needle').hits.map(hit => hit.page).sort()).toEqual([1, 3])
    expect(getDocument(document.id).searchablePages).toBe(2)
  })
  it('retrieves bounded chunks with explicit continuation and never puts document text into metadata context', async () => {
    const document = await imported(); indexed(['SECRET_PDF_CONTENT '.repeat(1500), 'Another page'])
    const budget = { chars: 0, signal: new AbortController().signal }, sources: import('../src/core/documents/types').ReadingSource[] = []
    const result = JSON.parse(runDocumentReadingTool(document.id, 'read_document_pages', { start_page: 1, count: 1, offset: 0 }, budget, sources))
    expect(result.pages[0].text.length).toBeLessThan(8000)
    expect(result.nextPage).toBe(1); expect(result.nextOffset).toBeGreaterThan(0)
    expect(sources[0]).toMatchObject({ kind: 'document', documentId: document.id, page: 1 })
    expect(() => runDocumentReadingTool(document.id, 'read_document_pages', { start_page: 1, count: 100, offset: 0 }, budget, sources)).toThrow('three')
    const input = buildInput([{ seq: 0, role: 'context', text: `Document: ${document.title}\nCurrently reading page 1`, document: { id: document.id, page: 1 }, at: 'now' }, { seq: 1, role: 'user', text: 'Explain', at: 'now' }], 'read')
    expect(JSON.stringify(input)).not.toContain('SECRET_PDF_CONTENT')
  })
  it('migrates existing chat databases without changing their history and preserves document quotes', async () => {
    const document = await imported(); indexed(['A quoted passage'])
    db().exec('PRAGMA user_version=13'); closeDb()
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
    insertDocumentChat({ id: 'chat', documentId: document.id, startedOn: 1, model: 'gpt-5.6-terra', reasoning: null, title: '', messages: 0, createdAt: 'now', updatedAt: 'now' })
    const quote = { text: 'A quoted passage', from: 'document' as const, document: { id: document.id, page: 1 } }
    appendDocumentMessage('chat', { role: 'user', text: 'Explain', quote, at: 'now' })
    closeDb()
    expect(selectDocumentMessages('chat')[0]?.quote).toEqual(quote)
    expect(buildInput(selectDocumentMessages('chat'), 'read')[1]?.content).toContain('From the document (page 1)')
  })
  it('uses the course Ask configuration and retrieves only passages requested by the model', async () => {
    const { EventEmitter } = await import('node:events')
    const document = await imported(); indexed(['PRIVATE_PAGE_ONE', 'Relevant needle passage on page two', 'PRIVATE_PAGE_THREE'])
    const c = chat.createDocumentChat(document.id, 1)
    expect(c).toMatchObject(newAIConversation('chat'))
    const inputs: unknown[] = []
    aiMock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      inputs.push(structuredClone(options.input))
      expect(options.tools).toEqual(DOCUMENT_TOOLS)
      if (inputs.length === 1) return { text: '', aborted: false, citations: [], output: [
        { type: 'reasoning', id: 'reasoning', encrypted_content: 'opaque' },
        { type: 'function_call', name: 'search_document', call_id: 'search', arguments: JSON.stringify({ query: 'needle', cursor: 0, document_id: 'untrusted-other-document' }) }
      ] }
      if (inputs.length === 2) return { text: '', aborted: false, citations: [], output: [
        { type: 'function_call', name: 'read_document_pages', call_id: 'read', arguments: JSON.stringify({ start_page: 2, count: 1, offset: 0 }) }
      ] }
      options.onDelta('The relevant passage is on page 2.')
      return { text: 'The relevant passage is on page 2.', aborted: false, citations: [], output: [] }
    })
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    expect(await chat.sendDocumentMessage(sender as never, c.id, 'Find the needle', undefined, 1)).toMatchObject({ status: 'ok' })
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('documentChat:done', c.id, { stopped: false }))
    expect(inputs).toHaveLength(3)
    expect(JSON.stringify(inputs[0])).not.toMatch(/PRIVATE_PAGE|Relevant needle passage/)
    expect(JSON.stringify(inputs[1])).toContain('Relevant needle passage')
    expect(JSON.stringify(inputs[2])).toContain('opaque')
    expect(JSON.stringify(inputs)).not.toMatch(/PRIVATE_PAGE_ONE|PRIVATE_PAGE_THREE/)
    const answer = chat.getDocumentChat(c.id)!.messages.at(-1)!
    expect(answer).toMatchObject({ role: 'assistant', status: 'complete', localSources: [{ kind: 'document', documentId: document.id, page: 2 }] })
  })
  it('saves partial answers when stopped and ignores late output after removal', async () => {
    const { EventEmitter } = await import('node:events')
    const document = await imported(); indexed(['One page'])
    const c = chat.createDocumentChat(document.id, 1)
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    let release!: (value: unknown) => void
    aiMock.stream.mockImplementation((options: ChatStreamOptions) => {
      options.onDelta('Partial answer')
      return new Promise(resolve => { release = resolve })
    })
    expect(await chat.sendDocumentMessage(sender as never, c.id, 'Explain', undefined, 1)).toMatchObject({ status: 'ok' })
    await vi.waitFor(() => expect(aiMock.stream).toHaveBeenCalledOnce())
    expect(await chat.sendDocumentMessage(sender as never, c.id, 'Again', undefined, 1)).toEqual({ status: 'busy' })
    chat.cancelDocumentChat(c.id)
    expect(chat.getDocumentChat(c.id)!.messages.at(-1)).toMatchObject({ text: 'Partial answer', status: 'stopped' })
    await removeDocument(document.id)
    release({ text: 'A late full answer', aborted: false, citations: [], output: [] })
    await new Promise(resolve => setImmediate(resolve))
    expect(selectDocumentMessages(c.id)).toEqual([])
    expect(sender.send.mock.calls.filter(([channel]) => channel === 'documentChat:done')).toHaveLength(1)
  })
  it('requires a connection before storing a question and rejects quotes for another document', async () => {
    const { EventEmitter } = await import('node:events')
    const document = await imported(); indexed(['One page'])
    const c = chat.createDocumentChat(document.id, 1)
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    aiMock.key = ''
    expect(await chat.sendDocumentMessage(sender as never, c.id, 'Explain', undefined, 1)).toMatchObject({ status: 'connection-required' })
    expect(selectDocumentMessages(c.id)).toEqual([])
    aiMock.key = 'sk-local-test'
    aiMock.stream.mockResolvedValue({ text: 'Answer', aborted: false, citations: [], output: [] })
    await chat.sendDocumentMessage(sender as never, c.id, 'Explain', { text: 'Foreign passage', from: 'document', document: { id: 'other', page: 1 } }, 1)
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('documentChat:done', c.id, { stopped: false }))
    expect(selectDocumentMessages(c.id).find(message => message.role === 'user')?.quote).toBeUndefined()
  })
  it('bounds total retrieval and restricts bundled PDF resource access', async () => {
    const document = await imported(); indexed(['Passage'])
    const result = JSON.parse(runDocumentReadingTool(document.id, 'read_document_pages', { start_page: 1, count: 1, offset: 0 }, { chars: MAX_TURN_RETRIEVAL_CHARS, signal: new AbortController().signal }, []))
    expect(result.error).toContain('limit')
    await expect(readPdfResource('standardFontDataUrl', '../package.json')).rejects.toThrow('Invalid PDF resource')
    await expect(readPdfResource('unknown', 'package.json')).rejects.toThrow('Invalid PDF resource')
    expect((await readPdfResource('standardFontDataUrl', 'LiberationSans-Regular.ttf')).length).toBeGreaterThan(1000)
  })
  it('extracts headings when bookmarks are absent and preserves line breaks', () => {
    const item = (str: string, font: number, y: number) => ({ str, transform: [font, 0, 0, font, 40, y], width: str.length * font, height: font })
    const items = [item('Main heading', 24, 700), item('Body text with enough words to establish the normal font size.', 12, 660), item('Another body line.', 12, 640)]
    expect(pageHeadings(items, 1, 792)).toMatchObject([{ title: 'Main heading', page: 1, depth: 0 }])
    expect(pageText(items)).toContain('Main heading\nBody text')
  })
})
