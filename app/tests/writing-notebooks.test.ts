// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-writing-'))
let directory = root
const source = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
vi.mock('../src/main/courses', () => ({ getCourse: (id: string) => source.available && id === 'course-a' ? { title: 'Course A' } : null }))
vi.mock('../src/main/documents', () => ({ getDocument: () => { throw new Error('Unavailable') } }))
vi.mock('../src/main/coach', () => ({ getProject: () => null }))
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
const chats = await import('../src/main/writing-notebook-chatdb')
const reading = await import('../src/main/writing-notebook-reading')
let n = 0
beforeEach(() => { closeDb(); directory = join(root, String(++n)); createUser('Writer'); source.available = true })
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })
const association = { kind: 'course' as const, id: 'course-a', title: 'ignored renderer label' }
const write = (id: string, text: string) => { const notebook = notes.getWritingNotebook(id), page = notes.getWritingPage(id, notebook.selectedPageId); return notes.saveWritingPage(id, page.id, page.revision, text) }
describe('personal writing notebooks', () => {
  it('defaults to wide text without line numbers and persists validated notebook options', () => {
    const notebook = notes.createWritingNotebook('Layout')
    expect(notebook).toMatchObject({ textLayout: 'wide', showLineNumbers: false })
    notes.updateWritingNotebook(notebook.id, { textLayout: 'thin', showLineNumbers: true })
    expect(notes.getWritingNotebook(notebook.id)).toMatchObject({ textLayout: 'thin', showLineNumbers: true })
    const file = join(notes.writingNotebookDirectory(notebook.id), 'notebook.json')
    const metadata = JSON.parse(readFileSync(file, 'utf8'))
    delete metadata.textLayout; delete metadata.showLineNumbers
    writeFileSync(file, JSON.stringify(metadata))
    expect(notes.getWritingNotebook(notebook.id)).toMatchObject({ textLayout: 'wide', showLineNumbers: false })
    expect(() => notes.updateWritingNotebook(notebook.id, { textLayout: 'other' as 'wide' })).toThrow('Invalid text layout')
    expect(() => notes.updateWritingNotebook(notebook.id, { showLineNumbers: 'yes' as unknown as boolean })).toThrow('Invalid line number')
  })
  it('keeps notebook titles fixed after creation while allowing page renames', () => {
    const notebook = notes.createWritingNotebook('Original notebook')
    expect(() => notes.updateWritingNotebook(notebook.id, { title: 'Changed' } as unknown as Parameters<typeof notes.updateWritingNotebook>[1])).toThrow('cannot be changed')
    expect(notes.getWritingNotebook(notebook.id).title).toBe('Original notebook')
    notes.renameWritingPage(notebook.id, notebook.selectedPageId, 'New page title')
    expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).title).toBe('New page title')
  })
  it('creates an independent default page, persists revisions, and rejects stale saves', () => {
    const notebook = notes.createWritingNotebook('  My ideas  ')
    expect(notebook.title).toBe('My ideas'); expect(notebook.pages).toHaveLength(1)
    expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).markdown).toBe('')
    expect(write(notebook.id, '# Hello\n**World**')).toMatchObject({ ok: true, page: { revision: 1 } })
    expect(notes.saveWritingPage(notebook.id, notebook.selectedPageId, 0, 'stale')).toMatchObject({ ok: false, page: { markdown: '# Hello\n**World**' } })
    closeDb(); expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).markdown).toBe('# Hello\n**World**')
    expect(() => notes.saveWritingPage(notebook.id, notebook.selectedPageId, 1, 'x'.repeat(1024 * 1024 + 1))).toThrow('1 MiB')
  })
  it('supports duplicate titles, page management, and protects the final page', () => {
    const one = notes.createWritingNotebook('Same'), two = notes.createWritingNotebook('Same')
    expect(one.id).not.toBe(two.id)
    const added = notes.addWritingPage(one.id, 'Second'), second = added.selectedPageId
    expect(notes.renameWritingPage(one.id, second, 'Renamed').pages[1]?.title).toBe('Renamed')
    expect(notes.reorderWritingPages(one.id, [second, one.selectedPageId]).pages[0]?.id).toBe(second)
    expect(() => notes.reorderWritingPages(one.id, [second, second])).toThrow('Invalid page order')
    const remaining = notes.deleteWritingPage(one.id, second)
    expect(remaining.selectedPageId).toBe(one.selectedPageId)
    expect(() => notes.deleteWritingPage(one.id, one.selectedPageId)).toThrow('at least one')
  })
  it('ranks titles before page titles before contents, then association, and returns the matching page', () => {
    const content = notes.createWritingNotebook('Related notes', association); write(content.id, 'Calculus notes')
    const title = notes.createWritingNotebook('Calculus')
    const relatedTitle = notes.createWritingNotebook('Calculus', association)
    const page = notes.createWritingNotebook('A notebook'); const extra = notes.addWritingPage(page.id, 'Calculus')
    const hits = notes.searchWritingNotebooks('calcu', association)
    expect(hits.map(h => h.notebook.id)).toEqual([relatedTitle.id, title.id, page.id, content.id])
    expect(hits[2]?.pageId).toBe(extra.selectedPageId)
    expect(notes.searchWritingNotebooks('" OR *')).toEqual([])
  })
  it('rebuilds stale indexes after an interrupted save and keeps association labels when sources disappear', () => {
    const notebook = notes.createWritingNotebook('Linked', association)
    expect(notebook.association?.title).toBe('Course A')
    const file = join(notes.writingNotebookDirectory(notebook.id), `${notebook.selectedPageId}.json`)
    const page = JSON.parse(readFileSync(file, 'utf8')); page.markdown = 'unindexed recovery'; page.revision++; writeFileSync(file, JSON.stringify(page))
    expect(notes.searchWritingNotebooks('recovery')[0]?.notebook.id).toBe(notebook.id)
    source.available = false
    expect(notes.getWritingNotebook(notebook.id)).toMatchObject({ association: { title: 'Course A' }, associationAvailable: false })
    expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).markdown).toBe('unindexed recovery')
  })
  it('isolates users and retains conversations when a page is deleted', () => {
    const notebook = notes.createWritingNotebook('Private'), second = notes.addWritingPage(notebook.id)
    const session = (awaitUser())
    const at = new Date().toISOString()
    chats.insertWritingNotebookChat({ id: 'chat-1', notebookId: notebook.id, startedOn: second.selectedPageId, model: 'test', reasoning: null, provider: 'apiKey', title: '', messages: 0, createdAt: at, updatedAt: at })
    chats.appendWritingNotebookMessage('chat-1', { role: 'user', text: 'question', at, writingNotebook: { notebookId: notebook.id, pageId: second.selectedPageId, revision: 0, title: 'Historical title' } })
    notes.deleteWritingPage(notebook.id, second.selectedPageId)
    expect(chats.selectWritingNotebookMessages('chat-1')[0]?.writingNotebook?.title).toBe('Historical title')
    createUser('Another writer'); expect(notes.listWritingNotebooks()).toEqual([]); expect(chats.selectWritingNotebookChat('chat-1')).toBeNull()
    switchUser(session); expect(notes.listWritingNotebooks()).toHaveLength(1)
    notes.deleteWritingNotebook(notebook.id); expect(chats.selectWritingNotebookChat('chat-1')).toBeNull(); expect(db().prepare('SELECT * FROM writing_notebook_search').all()).toEqual([])
  })
  it('retrieves immutable bounded page snapshots and refuses foreign pages', () => {
    const notebook = notes.createWritingNotebook('Snapshot'); write(notebook.id, 'Old version '.repeat(1000))
    const snapshot = reading.notebookSnapshot(notebook); write(notebook.id, 'New version')
    const sources: import('../src/core/documents/types').ReadingSource[] = [], budget = { chars: 0, signal: new AbortController().signal }
    const result = JSON.parse(reading.runWritingReadingTool(notebook, snapshot, 'read_notebook_page', { page_id: notebook.selectedPageId, offset: 0 }, budget, sources))
    expect(result.text).toContain('Old version'); expect(result.nextOffset).toBe(6500); expect(sources[0]?.kind).toBe('writing-notebook')
    expect(() => reading.runWritingReadingTool(notebook, snapshot, 'read_notebook_page', { page_id: 'foreign', offset: 0 }, budget, sources)).toThrow('snapshot')
    expect(() => reading.runWritingReadingTool(notebook, snapshot, 'read_document_pages', {}, budget, sources)).toThrow('not available')
  })
  it('shows the floating notebooks button unless this user turns it off', async () => {
    const { getFloatingNotebookButton, setFloatingNotebookButton, readPreferences } = await import('../src/main/preferences')
    const { normalizePreferences } = await import('../src/core/preferences')
    expect(getFloatingNotebookButton()).toBe(true)
    expect(normalizePreferences({ floatingNotebookButton: 'no' })).toEqual({})
    expect(normalizePreferences({ floatingNotebookButton: false })).toEqual({ floatingNotebookButton: false })
    setFloatingNotebookButton(false)
    expect(getFloatingNotebookButton()).toBe(false)
    expect(readPreferences().floatingNotebookButton).toBe(false)
    const session = awaitUser()
    createUser('Another writer')
    expect(getFloatingNotebookButton()).toBe(true)
    switchUser(session)
    expect(getFloatingNotebookButton()).toBe(false)
    expect(setFloatingNotebookButton(true)).toBe(true)
    expect(readPreferences().floatingNotebookButton).toBe(true)
    expect(() => setFloatingNotebookButton('yes' as never)).toThrow(/notebooks button/)
  })
  it('never uses titles or unchecked asset paths as filesystem paths', () => {
    const notebook = notes.createWritingNotebook('../../still a title')
    expect(notes.getWritingNotebook(notebook.id).title).toBe('../../still a title')
    expect(() => notes.getWritingNotebook('../outside')).toThrow('Invalid notebook identity')
    expect(notes.writingNotebookAsset(notebook.id, '../../secret')).toBeNull()
  })
})
const { requireUser: awaitUser } = await import('../src/main/users')

it('round trips sketch geometry and colors without overwriting a saved page version', async () => {
  const { readNotebookSketch, saveNotebookSketch } = await import('../src/main/writing-notebook-sketch')
  const { darkSketchColors } = await import('../src/core/writing-notebooks/sketch')
  const notebook = notes.createWritingNotebook('Sketches'), id = notebook.id
  const first = `assets/${crypto.randomUUID()}.sketch.svg`, copy = `assets/${crypto.randomUUID()}.sketch.svg`
  const points = [[50, 70], [400, 200]]
  const model = { version: 1, width: 450, height: 300, marks: ['brush', 'circle', 'rectangle', 'arrow'].map((kind, i) => ({ kind, width: i + 1, points })) }
  saveNotebookSketch(id, first, model, darkSketchColors)
  write(id, `![Sketch](${first})`)
  const resized = { ...model, width: 120 }
  saveNotebookSketch(id, copy, resized, darkSketchColors)
  saveNotebookSketch(id, copy, resized, darkSketchColors)
  expect(readNotebookSketch(id, copy)).toEqual(resized)
  expect(() => saveNotebookSketch(id, first, resized, darkSketchColors)).toThrow('already exists')
  expect(notes.saveWritingPage(id, notebook.selectedPageId, 0, `![Sketch](${copy})`).ok).toBe(false)
  expect(readNotebookSketch(id, first)).toEqual(model)
  const svg = readFileSync(notes.writingNotebookAsset(id, first.slice(7))!, 'utf8')
  expect(svg).toContain('stroke="#ffffff"')
  expect(svg).toContain('<circle')
  expect(() => saveNotebookSketch(id, '../other.svg', model, darkSketchColors)).toThrow()
  expect(() => saveNotebookSketch(id, copy, { ...model, marks: [{ kind: 'brush', width: 2, points: [[NaN, 0]] }] }, darkSketchColors)).toThrow()
  expect(() => saveNotebookSketch(id, copy, model, { ...darkSketchColors, brush: 'url(http://example.com)' })).toThrow()
})
