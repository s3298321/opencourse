// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    // A page has no title property: its file name is its title.
    expect(notes.getWritingNotebook(notebook.id).pages[0]?.path).toBe('Untitled page.json')
    notes.renameWritingPage(notebook.id, notebook.selectedPageId, 'New page title')
    const renamed = notes.getWritingNotebook(notebook.id)
    expect(renamed.pages[0]?.path).toBe('New page title.json')
    expect(existsSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'New page title.json'))).toBe(true)
    expect(renamed.tree?.[0]).toMatchObject({ kind: 'page', id: notebook.selectedPageId, path: 'New page title.json' })
    const stored = JSON.parse(readFileSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'New page title.json'), 'utf8'))
    expect(stored).toMatchObject({ id: notebook.selectedPageId, revision: 0 })
    expect('title' in stored).toBe(false)
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
    expect(notes.renameWritingPage(one.id, second, 'Renamed').pages[1]?.path).toBe('Renamed.json')
    // The same title in the same folder gets a suffixed file name.
    expect(notes.renameWritingPage(one.id, second, 'Untitled page').pages[1]?.path).toBe('Untitled page 2.json')
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
    const file = join(notes.writingNotebookDirectory(notebook.id), 'pages', notebook.pages[0]!.path)
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
  it('creates a notebook in a chosen folder and keeps it listed, searchable, and savable', () => {
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const notebook = notes.createWritingNotebook('Chosen home', undefined, folder)
    expect(notes.writingNotebookDirectory(notebook.id)).toBe(folder)
    expect(existsSync(join(folder, 'notebook.json'))).toBe(true)
    expect(notes.listWritingNotebooks().map(n => n.id)).toContain(notebook.id)
    write(notebook.id, 'A chosen folder note')
    expect(notes.searchWritingNotebooks('chosen folder').map(h => h.notebook.id)).toEqual([notebook.id])
    closeDb()
    expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).markdown).toBe('A chosen folder note')
  })
  it('treats an absent or empty folder choice as the default location', () => {
    for (const choice of [undefined, null, '']) {
      const notebook = notes.createWritingNotebook('Default home', undefined, choice)
      expect(notes.writingNotebookDirectory(notebook.id).startsWith(directory)).toBe(true)
    }
  })
  it('accepts a non-empty folder and deletes only notebook-owned files from it', () => {
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    writeFileSync(join(folder, 'user-file.txt'), 'keep me')
    const notebook = notes.createWritingNotebook('Shared folder', undefined, folder)
    notes.addWritingPage(notebook.id, 'Extra')
    mkdirSync(join(folder, 'assets'))
    const asset = `${crypto.randomUUID()}.png`
    writeFileSync(join(folder, 'assets', asset), Buffer.from([137, 80, 78, 71]))
    expect(notes.writingNotebookAsset(notebook.id, asset)).toBe(join(folder, 'assets', asset))
    notes.deleteWritingNotebook(notebook.id)
    expect(existsSync(folder)).toBe(true)
    expect(readFileSync(join(folder, 'user-file.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(folder, 'notebook.json'))).toBe(false)
    expect(existsSync(join(folder, 'pages'))).toBe(false)
    expect(existsSync(join(folder, 'assets'))).toBe(false)
    expect(notes.listWritingNotebooks()).toEqual([])
    expect(db().prepare('SELECT * FROM writing_notebook_index').all()).toEqual([])
  })
  it('rejects unsafe folder choices', () => {
    const inside = join(directory, 'inside'); mkdirSync(inside)
    expect(() => notes.createWritingNotebook('Inside', undefined, inside)).toThrow('outside the OpenCourse data directory')
    expect(() => notes.createWritingNotebook('Relative', undefined, 'relative/path')).toThrow('Choose a folder')
    expect(() => notes.createWritingNotebook('Missing', undefined, join(root, 'opencourse-missing'))).toThrow('no longer exists')
    const file = join(root, 'opencourse-file.txt'); writeFileSync(file, 'x')
    expect(() => notes.createWritingNotebook('File', undefined, file)).toThrow('not a folder')
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const first = notes.createWritingNotebook('First', undefined, folder)
    expect(() => notes.createWritingNotebook('Again', undefined, folder)).toThrow('already a notebook')
    const metadata = readFileSync(join(folder, 'notebook.json'))
    rmSync(join(folder, 'notebook.json'))
    expect(() => notes.createWritingNotebook('Again', undefined, folder)).toThrow('already belongs to another notebook')
    writeFileSync(join(folder, 'notebook.json'), metadata)
    const child = join(folder, 'child'); mkdirSync(child)
    expect(() => notes.createWritingNotebook('Child', undefined, child)).toThrow('overlaps')
    expect(() => notes.createWritingNotebook('Parent', undefined, dirname(folder))).toThrow('overlaps')
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([first.id])
  })
  it('skips a missing custom folder and recovers when it returns', () => {
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const notebook = notes.createWritingNotebook('Traveling', undefined, folder)
    const at = new Date().toISOString()
    chats.insertWritingNotebookChat({ id: 'chat-travel', notebookId: notebook.id, startedOn: notebook.selectedPageId, model: 'test', reasoning: null, provider: 'apiKey', title: '', messages: 0, createdAt: at, updatedAt: at })
    const away = `${folder}-away`
    renameSync(folder, away)
    expect(notes.listWritingNotebooks()).toEqual([])
    expect(() => notes.getWritingNotebook(notebook.id)).toThrow('unavailable')
    expect(notes.searchWritingNotebooks('traveling')).toEqual([])
    expect(chats.selectWritingNotebookChat('chat-travel')).not.toBeNull()
    renameSync(away, folder)
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([notebook.id])
    expect(notes.getWritingNotebook(notebook.id).title).toBe('Traveling')
    expect(notes.searchWritingNotebooks('traveling').map(h => h.notebook.id)).toEqual([notebook.id])
  })
  it('keeps custom folders private to their user', () => {
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const notebook = notes.createWritingNotebook('Mine', undefined, folder)
    const session = awaitUser()
    createUser('Another writer')
    expect(notes.listWritingNotebooks()).toEqual([])
    const otherFolder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const other = notes.createWritingNotebook('Theirs', undefined, otherFolder)
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([other.id])
    switchUser(session)
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([notebook.id])
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

it('prunes sketch versions no saved page references, once past the grace period', async () => {
  const { pruneNotebookSketches, saveNotebookSketch } = await import('../src/main/writing-notebook-sketch')
  const { darkSketchColors } = await import('../src/core/writing-notebooks/sketch')
  const notebook = notes.createWritingNotebook('Pruning'), id = notebook.id
  pruneNotebookSketches(id) // No assets directory yet.
  const model = { version: 1, width: 450, height: 300, marks: [{ kind: 'brush', width: 2, points: [[10, 10], [100, 100]] }] }
  const asset = () => `assets/${crypto.randomUUID()}.sketch.svg`
  const kept = asset(), dropped = asset(), fresh = asset(), otherPage = asset()
  for (const ref of [kept, dropped, fresh, otherPage]) saveNotebookSketch(id, ref, model, darkSketchColors)
  write(id, `![Sketch](${kept})`)
  const second = notes.addWritingPage(id, 'Second')
  expect(notes.saveWritingPage(id, second.selectedPageId, 0, `![Sketch](${otherPage})`).ok).toBe(true)
  const assets = join(notes.writingNotebookDirectory(id), 'assets')
  const aged = new Date(Date.now() - 25 * 60 * 60 * 1000)
  const age = (name: string) => utimesSync(join(assets, name), aged, aged)
  age(kept.slice(7)); age(dropped.slice(7)); age(otherPage.slice(7))
  const temp = `${dropped.slice(7)}.${crypto.randomUUID()}.tmp`
  writeFileSync(join(assets, temp), 'partial write'); age(temp)
  const photo = `${crypto.randomUUID()}.png`
  writeFileSync(join(assets, photo), Buffer.from([137, 80, 78, 71])); age(photo)
  pruneNotebookSketches(id)
  expect(existsSync(join(assets, kept.slice(7)))).toBe(true) // Referenced by the first page.
  expect(existsSync(join(assets, otherPage.slice(7)))).toBe(true) // Referenced by another page.
  expect(existsSync(join(assets, fresh.slice(7)))).toBe(true) // Unreferenced, but inside the grace period.
  expect(existsSync(join(assets, photo))).toBe(true) // Not a sketch.
  expect(existsSync(join(assets, dropped.slice(7)))).toBe(false)
  expect(existsSync(join(assets, temp))).toBe(false)
})
