// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-folders-'))
let directory = root
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
const chats = await import('../src/main/writing-notebook-chatdb')
let n = 0
beforeEach(() => { closeDb(); directory = join(root, String(++n)); process.env['OPENCOURSE_RUN_PROFILE'] = directory; createUser('Writer') })
afterAll(() => { closeDb(); delete process.env['OPENCOURSE_RUN_PROFILE']; rmSync(root, { recursive: true, force: true }) })
const write = (id: string, text: string) => { const notebook = notes.getWritingNotebook(id), page = notes.getWritingPage(id, notebook.selectedPageId); return notes.saveWritingPage(id, page.id, page.revision, text) }
describe('custom notebook folders', () => {
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
  it('still refuses course and document links, with or without a folder', () => {
    const folder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const association = { kind: 'course' as const, id: 'course-a', title: 'Course A' }
    expect(() => notes.createWritingNotebook('Linked', association)).toThrow('not tied to a course')
    expect(() => notes.createWritingNotebook('Linked', association, folder)).toThrow('not tied to a course')
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
    const session = requireUser()
    createUser('Another writer')
    expect(notes.listWritingNotebooks()).toEqual([])
    const otherFolder = realpathSync(mkdtempSync(join(root, 'opencourse-custom-')))
    const other = notes.createWritingNotebook('Theirs', undefined, otherFolder)
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([other.id])
    switchUser(session)
    expect(notes.listWritingNotebooks().map(n => n.id)).toEqual([notebook.id])
  })
})
const { requireUser } = await import('../src/main/users')