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
  pages: [{ id: pageA, title: 'Alpha' }, { id: pageB, title: 'Beta' }], selectedPageId: pageA, textScale: 1, chatOpen: false,
  tree: [
    { kind: 'folder', name: 'Research', path: 'Research', children: [
      { kind: 'folder', name: 'Inner', path: 'Research/Inner', children: [] },
      { kind: 'page', id: pageB, title: 'Beta', path: `Research/${pageB}.json` },
      { kind: 'file', name: 'notes.txt', path: 'Research/notes.txt' }
    ] },
    { kind: 'page', id: pageA, title: 'Alpha', path: `${pageA}.json` }
  ]
})
let actions: { [K in keyof PageTreeActions]: ReturnType<typeof vi.fn> }
const render = async (props: Partial<Parameters<typeof PageTree>[0]> = {}) => act(async () => {
  root.render(h(PageTree, { notebook: notebook(), currentPageId: pageA, selectedFolder: '', busy: false, draftFolder: null, onDraftCommit: vi.fn(), onDraftCancel: vi.fn(), actions, ...props }))
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  actions = { openPage: vi.fn(), selectFolder: vi.fn(), newPage: vi.fn(), newFolder: vi.fn(), deletePage: vi.fn(), deleteFolder: vi.fn(), deleteFile: vi.fn(), reveal: vi.fn(), move: vi.fn(), dropPage: vi.fn() }
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
  it('selects a folder on click and opens pages, while foreign files do nothing on click', async () => {
    await render()
    await act(async () => trigger(row('page', 'Alpha')).click())
    expect(actions.openPage).toHaveBeenCalledWith(pageA)
    await act(async () => trigger(row('file', 'notes.txt')).click())
    expect(actions.openPage).toHaveBeenCalledTimes(1)
    // Clicking a folder selects it and toggles it wrapped.
    await act(async () => trigger(row('folder', 'Research')).click())
    expect(actions.selectFolder).toHaveBeenCalledWith('Research')
    expect(container.textContent).not.toContain('notes.txt')
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
    expect(menuItems().map(item => item.textContent)).toEqual(['New page here', 'New folder here', 'Reveal in Finder', 'Delete folder'])
    await clickItem('New page here')
    expect(actions.newPage).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('New folder here')
    expect(actions.newFolder).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('Reveal in Finder')
    expect(actions.reveal).toHaveBeenCalledWith('Research')
    await contextMenu(row('folder', 'Research'))
    await clickItem('Delete folder')
    expect(actions.deleteFolder).toHaveBeenCalledWith('Research', 'Research', 1)
    await contextMenu(row('page', 'Beta'))
    expect(menuItems().map(item => item.textContent)).toEqual(['Delete page', 'Reveal in Finder'])
    await clickItem('Reveal in Finder')
    expect(actions.reveal).toHaveBeenCalledWith(`Research/${pageB}.json`)
    await contextMenu(row('file', 'notes.txt'))
    expect(menuItems().map(item => item.textContent)).toEqual(['Delete file', 'Reveal in Finder'])
    await clickItem('Delete file')
    expect(actions.deleteFile).toHaveBeenCalledWith('Research/notes.txt', 'notes.txt')
  })
  it('protects the final page in the delete menu', async () => {
    const single = notebook()
    single.pages = [{ id: pageA, title: 'Alpha' }]
    single.tree = [{ kind: 'page', id: pageA, title: 'Alpha', path: `${pageA}.json` }]
    await render({ notebook: single })
    await contextMenu(row('page', 'Alpha'))
    expect(menuItems()[0]!.disabled).toBe(true)
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
  it('moves entries by dropping them on folders and refuses a folder into its own subtree', async () => {
    await render()
    const source = trigger(row('page', 'Alpha'))
    await act(async () => { source.dispatchEvent(dragEvent('dragstart')) })
    const target = row('folder', 'Research')
    const over = dragEvent('dragover')
    await act(async () => { target.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(true)
    await act(async () => { target.dispatchEvent(dragEvent('drop')) })
    expect(actions.move).toHaveBeenCalledWith(`${pageA}.json`, 'Research')
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
})