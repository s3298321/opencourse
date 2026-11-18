// @vitest-environment jsdom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PageTree, { type PageTreeActions } from '../src/renderer/writing-notebooks/PageTree'
import type { WritingNotebook } from '../src/core/writing-notebooks/types'
let root: Root, container: HTMLDivElement
const pageA = crypto.randomUUID(), pageB = crypto.randomUUID()
const notebook = (): WritingNotebook => ({
  id: crypto.randomUUID(), version: 1, title: 'Tree', createdAt: '', updatedAt: '', lastAccessedAt: '',
  pages: [{ id: pageA, path: 'Alpha.json' }, { id: pageB, path: 'Research/Beta.json' }], selectedPageId: pageA, textScale: 1, chatOpen: false,
  tree: [
    { kind: 'folder', name: 'Research', path: 'Research', children: [
      { kind: 'folder', name: 'Inner', path: 'Research/Inner', children: [] },
      { kind: 'page', id: pageB, path: 'Research/Beta.json' },
      { kind: 'file', name: 'notes.txt', path: 'Research/notes.txt' }
    ] },
    { kind: 'page', id: pageA, path: 'Alpha.json' }
  ]
})
let actions: { [K in keyof PageTreeActions]: ReturnType<typeof vi.fn> }
const render = async (props: Partial<Parameters<typeof PageTree>[0]> = {}) => act(async () => {
  root.render(h(PageTree, { notebook: notebook(), currentPageId: pageA, currentFilePath: null, selectedFolder: '', busy: false, draftFolder: null, draftFile: null, onDraftCommit: vi.fn(), onFileDraftCommit: vi.fn(), onDraftCancel: vi.fn(), onFileDraftCancel: vi.fn(), actions, ...props }))
})
const row = (kind: 'folder' | 'page' | 'file', name: string) => [...container.querySelectorAll<HTMLElement>(`.writing-tree-row.${kind}`)].find(el => el.textContent?.includes(name))!
const trigger = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.menu-trigger')!
const contextMenu = async (el: HTMLElement) => act(async () => { trigger(el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })) })
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.menu-panel .menu-item')]
const clickItem = async (label: string) => act(async () => { menuItems().find(item => item.textContent?.includes(label))!.click() })
const dragEvent = (type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), getData: () => '', effectAllowed: 'uninitialized', dropEffect: 'none' } })
  return event
}
// A drag from outside the app (Finder, downloads, screenshots): the 'Files' type, no internal entry.
const fileDragEvent = (type: string, files: File[], init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), getData: () => '', effectAllowed: 'uninitialized', dropEffect: 'none', types: ['Files'], files } })
  return event
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  actions = { openPage: vi.fn(), openFile: vi.fn(), selectFolder: vi.fn(), newPage: vi.fn(), newFolder: vi.fn(), newFile: vi.fn(), deletePage: vi.fn(), deleteFolder: vi.fn(), deleteFile: vi.fn(), rename: vi.fn(), renamePage: vi.fn(), reveal: vi.fn(), move: vi.fn(), dropPage: vi.fn(), importFiles: vi.fn() }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
describe('notebook page tree', () => {
  it('renders folders, pages and foreign files, and wraps and unwraps folders', async () => {
    await render()
    expect(row('folder', 'Research')).toBeTruthy()
    expect(row('folder', 'Inner')).toBeTruthy()
    expect(row('page', 'Beta')).toBeTruthy()
    expect(row('file', 'notes.txt')).toBeTruthy()
    expect(row('folder', 'Research').querySelector('.writing-tree-toggle svg')).toBeTruthy()
    expect(row('page', 'Alpha').querySelector('svg.writing-tree-icon')).toBeTruthy()
    expect(row('file', 'notes.txt').querySelector('svg.writing-tree-icon')).toBeTruthy()
    await act(async () => row('folder', 'Research').querySelector<HTMLButtonElement>('.writing-tree-toggle')!.click())
    expect(container.textContent).not.toContain('Inner')
    expect(container.textContent).not.toContain('notes.txt')
    await act(async () => row('folder', 'Research').querySelector<HTMLButtonElement>('.writing-tree-toggle')!.click())
    expect(row('folder', 'Inner')).toBeTruthy()
  })
  it('selects a folder on click and opens pages and files on click', async () => {
    await render()
    await act(async () => trigger(row('page', 'Alpha')).click())
    expect(actions.openPage).toHaveBeenCalledWith(pageA)
    await act(async () => trigger(row('file', 'notes.txt')).click())
    expect(actions.openPage).toHaveBeenCalledTimes(1)
    expect(actions.openFile).toHaveBeenCalledWith('Research/notes.txt')
    // Clicking a folder selects it and toggles it wrapped.
    await act(async () => trigger(row('folder', 'Research')).click())
    expect(actions.selectFolder).toHaveBeenCalledWith('Research')
    expect(container.textContent).not.toContain('notes.txt')
  })
  it('marks the open file as current in the tree, and the page only while no file is open', async () => {
    await render({ currentFilePath: 'Research/notes.txt' })
    expect(row('file', 'notes.txt').classList.contains('current')).toBe(true)
    expect(row('page', 'Alpha').classList.contains('current')).toBe(false)
    await render({ currentFilePath: null })
    expect(row('file', 'notes.txt').classList.contains('current')).toBe(false)
    expect(row('page', 'Alpha').classList.contains('current')).toBe(true)
  })
  it('clears the folder selection when the empty pane below the rows is clicked', async () => {
    await render({ selectedFolder: 'Research' })
    expect(row('folder', 'Research').classList.contains('selected')).toBe(true)
    const nav = container.querySelector<HTMLElement>('nav.writing-tree')!
    await act(async () => { nav.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(actions.selectFolder).toHaveBeenCalledWith('')
    // A click on a row is not a click on the bare pane: the selection stays.
    actions.selectFolder.mockClear()
    await act(async () => { trigger(row('page', 'Alpha')).click() })
    expect(actions.selectFolder).not.toHaveBeenCalled()
  })
  it('offers creation, reveal and delete on folders, and delete and reveal on pages and files', async () => {
    await render()
    await contextMenu(row('folder', 'Research'))
    expect(menuItems().map(item => item.textContent)).toEqual(['Rename', 'New page here', 'New folder here', 'New file here', 'Reveal in Finder', 'Delete folder'])
    await clickItem('New page here')
    expect(actions.newPage).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('New folder here')
    expect(actions.newFolder).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('New file here')
    expect(actions.newFile).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('Reveal in Finder')
    expect(actions.reveal).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('Delete folder')
    expect(actions.deleteFolder).toHaveBeenCalledWith('Research', 'Research', 1)
    await contextMenu(row('page', 'Beta'))
    expect(menuItems().map(item => item.textContent)).toEqual(['Rename', 'Reveal in Finder', 'Delete page'])
    await clickItem('Reveal in Finder')
    expect(actions.reveal).toHaveBeenCalledWith('Research/Beta.json')
    await contextMenu(row('file', 'notes.txt'))
    expect(menuItems().map(item => item.textContent)).toEqual(['Rename', 'Reveal in Finder', 'Delete file'])
    await clickItem('Delete file')
    expect(actions.deleteFile).toHaveBeenCalledWith('Research/notes.txt', 'notes.txt')
  })
  it('protects the final page in the delete menu', async () => {
    const single = notebook()
    single.pages = [{ id: pageA, path: 'Alpha.json' }]
    single.tree = [{ kind: 'page', id: pageA, path: 'Alpha.json' }]
    await render({ notebook: single })
    await contextMenu(row('page', 'Alpha'))
    expect(menuItems().find(item => item.textContent?.includes('Delete page'))!.disabled).toBe(true)
  })
  it('renames a row in place: prefilled selected input, Enter or blur applies, Escape or an unchanged name cancels', async () => {
    await render()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const type = async (input: HTMLInputElement, value: string) => act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    // A folder: right-click → Rename → the row becomes an input with the current name, fully selected.
    await contextMenu(row('folder', 'Research'))
    await clickItem('Rename')
    const folderInput = container.querySelector<HTMLInputElement>('input[aria-label="Rename Research"]')!
    expect(folderInput).toBeTruthy()
    // The folder row itself transformed into the input row (the nested Inner folder stays a row).
    expect([...container.querySelectorAll('.writing-tree-row.folder')].some(el => el.textContent?.includes('Research'))).toBe(false)
    expect(container.querySelector('.writing-tree-row.rename input')).toBe(folderInput)
    expect(folderInput.value).toBe('Research')
    expect(folderInput.selectionStart).toBe(0)
    expect(folderInput.selectionEnd).toBe('Research'.length)
    await type(folderInput, 'Studies')
    await act(async () => { folderInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(actions.rename).toHaveBeenCalledWith('Research', 'Studies')
    // A page renames by title; clicking elsewhere (blur) applies it.
    await contextMenu(row('page', 'Beta'))
    await clickItem('Rename')
    const pageInput = container.querySelector<HTMLInputElement>('input[aria-label="Rename Beta"]')!
    expect(pageInput.value).toBe('Beta')
    expect(pageInput.selectionStart).toBe(0)
    expect(pageInput.selectionEnd).toBe('Beta'.length)
    await type(pageInput, 'Beta v2')
    await act(async () => { pageInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(actions.renamePage).toHaveBeenCalledWith(pageB, 'Beta v2')
    // A file renames by path; Escape cancels without applying.
    await contextMenu(row('file', 'notes.txt'))
    await clickItem('Rename')
    const fileInput = container.querySelector<HTMLInputElement>('input[aria-label="Rename notes.txt"]')!
    expect(fileInput.value).toBe('notes.txt')
    await type(fileInput, 'renamed.txt')
    await act(async () => { fileInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(actions.rename).toHaveBeenCalledTimes(1)
    // An unchanged name is a no-op.
    await contextMenu(row('file', 'notes.txt'))
    await clickItem('Rename')
    const sameInput = container.querySelector<HTMLInputElement>('input[aria-label="Rename notes.txt"]')!
    await act(async () => { sameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(actions.rename).toHaveBeenCalledTimes(1)
    expect(actions.renamePage).toHaveBeenCalledTimes(1)
  })
  it('names a new folder inline: Enter commits, Escape cancels', async () => {
    const onDraftCommit = vi.fn(), onDraftCancel = vi.fn()
    await render({ draftFolder: { parent: 'Research' }, onDraftCommit, onDraftCancel })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!
    expect(input.closest('.writing-tree-branch')?.textContent).toContain('Research')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Fresh'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(onDraftCommit).toHaveBeenCalledWith('Fresh')
    await render({ draftFolder: { parent: '' }, onDraftCommit, onDraftCancel })
    const rootInput = container.querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!
    await act(async () => { rootInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(onDraftCancel).toHaveBeenCalled()
  })
  it('names a new file inline with a file icon: Enter commits the name with its extension, Escape cancels', async () => {
    const onFileDraftCommit = vi.fn(), onFileDraftCancel = vi.fn()
    await render({ draftFile: { parent: 'Research' }, onFileDraftCommit, onFileDraftCancel })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New file name"]')!
    expect(input.closest('.writing-tree-branch')?.textContent).toContain('Research')
    expect(input.closest('.writing-tree-row.draft')?.querySelector('svg.writing-tree-icon')).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'notes.md'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(onFileDraftCommit).toHaveBeenCalledWith('notes.md')
    await render({ draftFile: { parent: '' }, onFileDraftCommit, onFileDraftCancel })
    const rootInput = container.querySelector<HTMLInputElement>('input[aria-label="New file name"]')!
    expect(rootInput.closest('nav.writing-tree')).toBeTruthy()
    await act(async () => { rootInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(onFileDraftCancel).toHaveBeenCalled()
  })
  it('moves entries by dropping them on folders and refuses a folder into its own subtree', async () => {
    await render()
    const source = trigger(row('page', 'Alpha'))
    await act(async () => { source.dispatchEvent(dragEvent('dragstart')) })
    const target = row('folder', 'Research')
    const over = dragEvent('dragover')
    await act(async () => { target.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(true)
    await act(async () => { target.dispatchEvent(dragEvent('drop')) })
    expect(actions.move).toHaveBeenCalledWith('Alpha.json', 'Research')
    // A folder cannot drop into its own descendant.
    await act(async () => { trigger(row('folder', 'Research')).dispatchEvent(dragEvent('dragstart')) })
    const inner = row('folder', 'Inner')
    const refused = dragEvent('dragover')
    await act(async () => { inner.dispatchEvent(refused) })
    expect(refused.defaultPrevented).toBe(false)
    await act(async () => { inner.dispatchEvent(dragEvent('drop')) })
    expect(actions.move).toHaveBeenCalledTimes(1)
    // Dropping on the empty root area moves back to the root.
    await act(async () => { trigger(row('file', 'notes.txt')).dispatchEvent(dragEvent('dragstart')) })
    const nav = container.querySelector<HTMLElement>('nav.writing-tree')!
    await act(async () => { nav.dispatchEvent(dragEvent('dragover')) })
    await act(async () => { nav.dispatchEvent(dragEvent('drop')) })
    expect(actions.move).toHaveBeenCalledWith('Research/notes.txt', '')
  })
  it('reorders pages by dropping above or below a sibling', async () => {
    await render()
    const target = row('page', 'Beta')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 10, height: 20, bottom: 30, left: 0, right: 100, width: 100, x: 0, y: 10, toJSON: () => ({}) })
    await act(async () => { trigger(row('page', 'Alpha')).dispatchEvent(dragEvent('dragstart')) })
    await act(async () => { target.dispatchEvent(dragEvent('dragover', { clientY: 25 })) })
    await act(async () => { target.dispatchEvent(dragEvent('drop', { clientY: 25 })) })
    expect(actions.dropPage).toHaveBeenCalledWith(pageA, 'Research', { pageId: pageB, after: true })
    await act(async () => { trigger(row('page', 'Alpha')).dispatchEvent(dragEvent('dragstart')) })
    await act(async () => { target.dispatchEvent(dragEvent('drop', { clientY: 12 })) })
    expect(actions.dropPage).toHaveBeenLastCalledWith(pageA, 'Research', { pageId: pageB, after: false })
  })
  it('copies foreign files dropped on folders, pages and the empty root pane, highlighting each target', async () => {
    await render()
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    // Over a folder: the folder row highlights and the drop copies into that folder.
    const research = row('folder', 'Research')
    // During dragover Chromium reports the 'Files' type but an empty FileList; files arrive on drop.
    const over = fileDragEvent('dragover', [])
    await act(async () => { research.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(true)
    expect((over as unknown as { dataTransfer: DataTransfer }).dataTransfer.dropEffect).toBe('copy')
    expect(research.classList.contains('drop-target')).toBe(true)
    await act(async () => { research.dispatchEvent(fileDragEvent('drop', [file])) })
    expect(actions.importFiles).toHaveBeenCalledWith('Research', [file])
    expect(research.classList.contains('drop-target')).toBe(false)
    // Over a page: the file lands in the page's own folder.
    const beta = row('page', 'Beta')
    await act(async () => { beta.dispatchEvent(fileDragEvent('dragover', [file])) })
    expect(beta.classList.contains('drop-target')).toBe(true)
    await act(async () => { beta.dispatchEvent(fileDragEvent('drop', [file])) })
    expect(actions.importFiles).toHaveBeenLastCalledWith('Research', [file])
    // Over the empty pane below the rows: the whole pane highlights and the file goes to the root.
    const nav = container.querySelector<HTMLElement>('nav.writing-tree')!
    await act(async () => { nav.dispatchEvent(fileDragEvent('dragover', [file])) })
    expect(nav.classList.contains('drop-root')).toBe(true)
    await act(async () => { nav.dispatchEvent(fileDragEvent('drop', [file])) })
    expect(actions.importFiles).toHaveBeenLastCalledWith('', [file])
    expect(nav.classList.contains('drop-root')).toBe(false)
    // Leaving the pane clears the highlight.
    await act(async () => { nav.dispatchEvent(fileDragEvent('dragover', [file])) })
    expect(nav.classList.contains('drop-root')).toBe(true)
    await act(async () => { nav.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null })) })
    expect(nav.classList.contains('drop-root')).toBe(false)
    // A drag that carries no files (no 'Files' type) does nothing, and an internal drag still moves instead of importing.
    await act(async () => { nav.dispatchEvent(dragEvent('dragover')) })
    expect(nav.classList.contains('drop-root')).toBe(false)
    await act(async () => { trigger(row('page', 'Alpha')).dispatchEvent(dragEvent('dragstart')) })
    await act(async () => { research.dispatchEvent(dragEvent('dragover')) })
    await act(async () => { research.dispatchEvent(dragEvent('drop')) })
    expect(actions.move).toHaveBeenCalledWith('Alpha.json', 'Research')
    expect(actions.importFiles).toHaveBeenCalledTimes(3)
  })
})