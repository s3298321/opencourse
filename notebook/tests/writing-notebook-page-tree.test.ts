// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-page-tree-'))
let directory = root
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
const { createUser } = await import('../src/main/users')
const { closeDb, db } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
const tree = await import('../src/main/writing-notebook-tree')
const { buildWritingTree, folderName, treePath } = await import('../src/core/writing-notebooks/tree')
let n = 0
beforeEach(() => { closeDb(); directory = join(root, String(++n)); process.env['OPENCOURSE_RUN_PROFILE'] = directory; createUser('Writer') })
afterAll(() => { closeDb(); delete process.env['OPENCOURSE_RUN_PROFILE']; rmSync(root, { recursive: true, force: true }) })
const write = (id: string, text: string, pageId?: string) => { const notebook = notes.getWritingNotebook(id), page = notes.getWritingPage(id, pageId ?? notebook.selectedPageId); return notes.saveWritingPage(id, page.id, page.revision, text) }
type FolderNode = Extract<import('../src/core/writing-notebooks/types').WritingTreeNode, { kind: 'folder' }>
const folderNode = (notebook: ReturnType<typeof notes.getWritingNotebook>, path: string): FolderNode | undefined => {
  const walk = (nodes: NonNullable<typeof notebook.tree>): FolderNode | undefined => {
    for (const node of nodes) { if (node.kind === 'folder' && node.path === path) return node; if (node.kind === 'folder') { const found = walk(node.children); if (found) return found } }
    return undefined
  }
  return walk(notebook.tree ?? [])
}
describe('notebook page tree storage', () => {
  it('creates new notebooks with their page inside the tree root and assets outside it', () => {
    const notebook = notes.createWritingNotebook('Tree home')
    const dir = notes.writingNotebookDirectory(notebook.id)
    expect(existsSync(join(dir, 'pages', `${notebook.selectedPageId}.json`))).toBe(true)
    expect(existsSync(join(dir, `${notebook.selectedPageId}.json`))).toBe(false)
    expect(notebook.tree).toEqual([{ kind: 'page', id: notebook.selectedPageId, title: 'Untitled page', path: `${notebook.selectedPageId}.json` }])
    // The derived tree never lands in notebook.json.
    const metadata = JSON.parse(readFileSync(join(dir, 'notebook.json'), 'utf8'))
    expect(metadata.tree).toBeUndefined()
  })
  it('creates nested folders and pages, ordering folders first, pages manually, files last', () => {
    const notebook = notes.createWritingNotebook('Nesting')
    notes.createWritingFolder(notebook.id, '', 'Research')
    notes.createWritingFolder(notebook.id, 'Research', '2026')
    notes.createWritingFolder(notebook.id, '', 'Archive')
    const inner = notes.addWritingPage(notebook.id, 'Deep page', 'Research/2026')
    const outer = notes.addWritingPage(notebook.id, 'Research page', 'Research')
    writeFileSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Research', 'zebra.txt'), 'foreign')
    writeFileSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Research', 'alpha.pdf'), 'foreign')
    const refreshed = notes.getWritingNotebook(notebook.id)
    expect(refreshed.tree?.map(node => node.kind === 'folder' ? node.name : node.kind)).toEqual(['Archive', 'Research', 'page'])
    const research = folderNode(refreshed, 'Research')!
    expect(research.kind === 'folder' && research.children.map(node => node.kind === 'folder' ? node.name : node.kind === 'page' ? node.title : node.name)).toEqual(['2026', 'Research page', 'alpha.pdf', 'zebra.txt'])
    expect(folderNode(refreshed, 'Research/2026')?.children[0]).toMatchObject({ kind: 'page', id: inner.selectedPageId, title: 'Deep page' })
    expect(notes.getWritingPage(notebook.id, outer.selectedPageId).title).toBe('Research page')
    expect(notes.getWritingPage(notebook.id, inner.selectedPageId).markdown).toBe('')
    // Duplicate names in the same folder are refused; the same name elsewhere is fine.
    expect(() => notes.createWritingFolder(notebook.id, '', 'Research')).toThrow('already exists')
    notes.createWritingFolder(notebook.id, 'Archive', 'Research')
    expect(() => notes.createWritingFolder(notebook.id, 'Missing', 'X')).toThrow('no longer exists')
    expect(() => notes.createWritingFolder(notebook.id, '', '../escape')).toThrow()
    expect(() => notes.createWritingFolder(notebook.id, '', 'a/b')).toThrow()
    expect(() => notes.createWritingFolder(notebook.id, '', '.hidden')).toThrow()
    expect(() => notes.createWritingFolder(notebook.id, '', '')).toThrow('between 1 and 200')
  })
  it('moves pages, folders and foreign files while keeping page identity, content and search', () => {
    const notebook = notes.createWritingNotebook('Moving')
    const moved = notes.addWritingPage(notebook.id, 'Movable')
    write(notebook.id, 'findable moving text', moved.selectedPageId)
    notes.createWritingFolder(notebook.id, '', 'Target')
    notes.createWritingFolder(notebook.id, '', 'Carrier')
    notes.createWritingFolder(notebook.id, 'Carrier', 'Child')
    writeFileSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Carrier', 'note.txt'), 'foreign')
    const pagePath = `${moved.selectedPageId}.json`
    notes.moveWritingEntry(notebook.id, pagePath, 'Target')
    expect(existsSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Target', pagePath))).toBe(true)
    expect(notes.getWritingPage(notebook.id, moved.selectedPageId).markdown).toBe('findable moving text')
    expect(notes.searchWritingNotebooks('findable moving').map(hit => hit.notebook.id)).toEqual([notebook.id])
    // A whole folder moves with its pages and files; the page id is unchanged.
    notes.moveWritingEntry(notebook.id, 'Carrier', 'Target')
    expect(folderNode(notes.getWritingNotebook(notebook.id), 'Target/Carrier/Child')).toBeTruthy()
    expect(existsSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Target', 'Carrier', 'note.txt'))).toBe(true)
    // Refusals: into itself or a descendant, onto a collision, out of the tree.
    expect(() => notes.moveWritingEntry(notebook.id, 'Target', 'Target/Carrier')).toThrow('into itself')
    expect(() => notes.moveWritingEntry(notebook.id, 'Target', 'Target')).toThrow('into itself')
    notes.createWritingFolder(notebook.id, '', 'note.txt')
    expect(() => notes.moveWritingEntry(notebook.id, 'Target/Carrier/note.txt', '')).toThrow('already exists')
    notes.moveWritingEntry(notebook.id, 'Target/Carrier/note.txt', 'Target')
    expect(folderNode(notes.getWritingNotebook(notebook.id), 'Target')?.children.some(node => node.kind === 'file' && node.name === 'note.txt')).toBe(true)
    expect(() => notes.moveWritingEntry(notebook.id, pagePath, '../outside')).toThrow()
    expect(() => notes.moveWritingEntry(notebook.id, '/etc/passwd', '')).toThrow()
    expect(() => notes.moveWritingEntry(notebook.id, '', 'Target')).toThrow('root cannot be moved')
    expect(() => notes.moveWritingEntry(notebook.id, 'Target', 'Missing')).toThrow('no longer exists')
    // Moving a page back to the root keeps it savable.
    notes.moveWritingEntry(notebook.id, `Target/${pagePath}`, '')
    write(notebook.id, 'still savable', moved.selectedPageId)
    expect(notes.getWritingPage(notebook.id, moved.selectedPageId).markdown).toBe('still savable')
  })
  it('deletes folders with their pages and files, fixing selection and the search index', () => {
    const notebook = notes.createWritingNotebook('Doomed folder')
    const kept = notebook.selectedPageId
    notes.createWritingFolder(notebook.id, '', 'Doomed')
    const inside = notes.addWritingPage(notebook.id, 'Inside', 'Doomed')
    write(notebook.id, 'doomed unique content', inside.selectedPageId)
    writeFileSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Doomed', 'file.txt'), 'x')
    expect(notes.searchWritingNotebooks('doomed unique').length).toBe(1)
    const result = notes.deleteWritingFolder(notebook.id, 'Doomed')
    expect(result.pages.map(page => page.id)).toEqual([kept])
    expect(result.selectedPageId).toBe(kept)
    expect(existsSync(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Doomed'))).toBe(false)
    expect(notes.searchWritingNotebooks('doomed unique')).toEqual([])
    expect(db().prepare('SELECT * FROM writing_notebook_search WHERE page_id=?').all(inside.selectedPageId)).toEqual([])
    // The last page is protected, and the root is not a folder.
    notes.createWritingFolder(notebook.id, '', 'Everything')
    notes.moveWritingEntry(notebook.id, `${kept}.json`, 'Everything')
    expect(() => notes.deleteWritingFolder(notebook.id, 'Everything')).toThrow('at least one')
    expect(() => notes.deleteWritingFolder(notebook.id, '')).toThrow('root cannot be deleted')
    expect(() => notes.deleteWritingFolder(notebook.id, 'Missing')).toThrow('no longer exists')
  })
  it('shows foreign files, deletes them on request, and never opens or deletes them as pages', () => {
    const notebook = notes.createWritingNotebook('Foreign')
    const dir = join(notes.writingNotebookDirectory(notebook.id), 'pages')
    writeFileSync(join(dir, 'photo.png'), 'not really a png')
    writeFileSync(join(dir, `${crypto.randomUUID()}.json`), '{"stray":true}')
    const refreshed = notes.getWritingNotebook(notebook.id)
    const files = refreshed.tree?.filter(node => node.kind === 'file') ?? []
    const names = files.map(node => node.kind === 'file' ? node.name : '')
    expect(names).toContain('photo.png')
    expect(names.some(name => /^[0-9a-f-]{36}\.json$/.test(name))).toBe(true)
    expect(files).toHaveLength(2)
    expect(() => notes.deleteWritingFile(notebook.id, `${notebook.selectedPageId}.json`)).toThrow('context menu')
    notes.deleteWritingFile(notebook.id, 'photo.png')
    expect(existsSync(join(dir, 'photo.png'))).toBe(false)
    expect(() => notes.deleteWritingFile(notebook.id, 'photo.png')).toThrow('no longer exists')
    expect(() => notes.deleteWritingFile(notebook.id, '..')).toThrow()
    // Dotfiles and symlinks never enter the tree.
    writeFileSync(join(dir, '.DS_Store'), 'x')
    symlinkSync(join(dir, 'photo.png'), join(dir, 'link.png'))
    mkdirSync(join(dir, 'Real'))
    symlinkSync(join(dir, 'Real'), join(dir, 'Linked'))
    expect(notes.getWritingNotebook(notebook.id).tree?.some(node => node.kind !== 'page' && node.name.startsWith('.'))).toBe(false)
    expect(notes.getWritingNotebook(notebook.id).tree?.some(node => node.kind !== 'page' && node.name === 'link.png')).toBe(false)
    expect(notes.getWritingNotebook(notebook.id).tree?.some(node => node.kind === 'folder' && node.name === 'Linked')).toBe(false)
    expect(() => notes.deleteWritingFile(notebook.id, 'link.png')).toThrow()
  })
  it('migrates flat pre-tree notebooks lazily, including half-migrated ones', () => {
    const notebook = notes.createWritingNotebook('Legacy')
    const first = notebook.selectedPageId
    const second = notes.addWritingPage(notebook.id, 'Second')
    write(notebook.id, 'legacy content', first)
    const dir = notes.writingNotebookDirectory(notebook.id)
    // Recreate the old flat layout, leaving one page already in the tree.
    renameSync(join(dir, 'pages', `${first}.json`), join(dir, `${first}.json`))
    rmSync(join(dir, 'pages', `${second.selectedPageId}.json`))
    writeFileSync(join(dir, `${second.selectedPageId}.json`), JSON.stringify({ id: second.selectedPageId, title: 'Second', revision: 0, markdown: 'flat second', updatedAt: new Date().toISOString() }))
    const migrated = notes.getWritingNotebook(notebook.id)
    expect(existsSync(join(dir, 'pages', `${first}.json`))).toBe(true)
    expect(existsSync(join(dir, 'pages', `${second.selectedPageId}.json`))).toBe(true)
    expect(existsSync(join(dir, `${first}.json`))).toBe(false)
    expect(migrated.pages).toHaveLength(2)
    expect(notes.getWritingPage(notebook.id, first).markdown).toBe('legacy content')
    expect(notes.getWritingPage(notebook.id, second.selectedPageId).markdown).toBe('flat second')
    expect(notes.searchWritingNotebooks('legacy content').map(hit => hit.notebook.id)).toEqual([notebook.id])
  })
  it('repairs metadata when page files vanish in Finder and follows Finder moves', () => {
    const notebook = notes.createWritingNotebook('Finder edits')
    const second = notes.addWritingPage(notebook.id, 'Second')
    const dir = notes.writingNotebookDirectory(notebook.id)
    rmSync(join(dir, 'pages', `${second.selectedPageId}.json`))
    const repaired = notes.getWritingNotebook(notebook.id)
    expect(repaired.pages.map(page => page.id)).toEqual([notebook.selectedPageId])
    expect(JSON.parse(readFileSync(join(dir, 'notebook.json'), 'utf8')).pages).toHaveLength(1)
    // A page moved by hand into a new folder is found at its new home.
    mkdirSync(join(dir, 'pages', 'Hand made'))
    renameSync(join(dir, 'pages', `${notebook.selectedPageId}.json`), join(dir, 'pages', 'Hand made', `${notebook.selectedPageId}.json`))
    const moved = notes.getWritingNotebook(notebook.id)
    expect(folderNode(moved, 'Hand made')?.children[0]).toMatchObject({ kind: 'page', id: notebook.selectedPageId })
    write(notebook.id, 'saved after a Finder move')
    expect(notes.getWritingPage(notebook.id, notebook.selectedPageId).markdown).toBe('saved after a Finder move')
    // Every page file gone: the notebook reports itself unreadable rather than empty.
    rmSync(join(dir, 'pages', 'Hand made', `${notebook.selectedPageId}.json`))
    expect(() => notes.getWritingNotebook(notebook.id)).toThrow('could not be read')
  })
  it('deletes a custom-folder notebook by removing its whole tree but nothing else', () => {
    const folder = mkdtempSync(join(root, 'opencourse-tree-custom-'))
    writeFileSync(join(folder, 'user-file.txt'), 'keep me')
    const notebook = notes.createWritingNotebook('Custom tree', undefined, folder)
    notes.createWritingFolder(notebook.id, '', 'Folder')
    notes.addWritingPage(notebook.id, 'Inside', 'Folder')
    writeFileSync(join(folder, 'pages', 'Folder', 'foreign.txt'), 'goes with the tree')
    notes.deleteWritingNotebook(notebook.id)
    expect(existsSync(join(folder, 'user-file.txt'))).toBe(true)
    expect(existsSync(join(folder, 'pages'))).toBe(false)
    expect(existsSync(join(folder, 'notebook.json'))).toBe(false)
  })
  it('bounds folder depth and validates paths in core', () => {
    expect(() => treePath('../up')).toThrow()
    expect(() => treePath('a//b')).toThrow()
    expect(() => treePath('a/./b')).toThrow()
    expect(() => treePath('/absolute')).toThrow()
    expect(() => treePath('a\\b')).toThrow()
    expect(() => treePath('.hidden/a')).toThrow()
    expect(treePath('')).toBe('')
    expect(() => folderName('x'.repeat(201))).toThrow()
    expect(() => folderName('a:b')).toThrow()
    expect(folderName('  spaced  ')).toBe('spaced')
    const deep = Array.from({ length: 33 }, (_, i) => `level${i}`).join('/')
    expect(() => treePath(deep)).toThrow('32 levels')
    const notebook = notes.createWritingNotebook('Depth')
    let parent = ''
    for (let i = 0; i < 32; i++) { notes.createWritingFolder(notebook.id, parent, `level${i}`); parent = parent ? `${parent}/level${i}` : `level${i}` }
    expect(() => notes.createWritingFolder(notebook.id, parent, 'one-too-many')).toThrow('32 levels')
    // Moving a deep subtree somewhere shallower is fine; deeper is refused.
    notes.createWritingFolder(notebook.id, '', 'shallow')
    expect(() => notes.moveWritingEntry(notebook.id, 'level0', 'shallow')).toThrow('32 levels')
    notes.moveWritingEntry(notebook.id, parent, '')
    expect(folderNode(notes.getWritingNotebook(notebook.id), 'level31')).toBeTruthy()
  })
  it('builds trees purely from listings and page order', () => {
    const pages = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }]
    const entries = [
      { path: 'z-folder', directory: true }, { path: 'a-folder', directory: true },
      { path: `b.json`, directory: false }, { path: `a.json`, directory: false },
      { path: 'z.txt', directory: false }, { path: 'a.txt', directory: false },
      { path: 'a-folder/inner', directory: true }, { path: 'stray.json', directory: false }
    ]
    // 'a' and 'b' are not UUIDs here, so every .json is foreign; use real ids for page matching.
    const idA = crypto.randomUUID(), idB = crypto.randomUUID()
    const real = buildWritingTree([
      { path: 'z-folder', directory: true }, { path: 'a-folder', directory: true },
      { path: `${idB}.json`, directory: false }, { path: `${idA}.json`, directory: false },
      { path: 'z.txt', directory: false }, { path: 'a.txt', directory: false }, { path: 'stray.json', directory: false }
    ], [{ id: idA, title: 'Alpha' }, { id: idB, title: 'Beta' }])
    expect(real.map(node => node.kind === 'folder' ? node.name : node.kind === 'page' ? node.title : node.name)).toEqual(['a-folder', 'z-folder', 'Alpha', 'Beta', 'a.txt', 'stray.json', 'z.txt'])
    expect(buildWritingTree(entries, pages).every(node => node.kind !== 'page')).toBe(true)
  })
  it('resolves reveal paths inside the tree and refuses escapes', () => {
    const notebook = notes.createWritingNotebook('Reveal')
    notes.createWritingFolder(notebook.id, '', 'Shown')
    expect(tree.resolveWritingTreePath(notebook.id, 'Shown')).toBe(join(notes.writingNotebookDirectory(notebook.id), 'pages', 'Shown'))
    expect(tree.resolveWritingTreePath(notebook.id, '')).toBe(join(notes.writingNotebookDirectory(notebook.id), 'pages'))
    expect(() => tree.resolveWritingTreePath(notebook.id, '../notebook.json')).toThrow()
    const dir = notes.writingNotebookDirectory(notebook.id)
    symlinkSync(join(dir, 'notebook.json'), join(dir, 'pages', 'sneaky.json'))
    expect(() => tree.resolveWritingTreePath(notebook.id, 'sneaky.json')).toThrow('Symbolic links')
  })
})