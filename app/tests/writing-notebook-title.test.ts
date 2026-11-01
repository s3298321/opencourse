import type { CoachContextRequest } from '../src/core/coach/context'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WritingNotebook, WritingNotebookPage } from '../src/core/writing-notebooks/types'
import NotebookWindow from '../src/renderer/writing-notebooks/NotebookWindow'

vi.mock('../src/renderer/markdown-context', () => ({ MarkdownProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('../src/renderer/components/ChatPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/writing-notebooks/MarkdownEditor', () => ({ default: (props: { onChange: (text: string) => void }) => { changeBody = props.onChange; return null } }))
vi.mock('../src/renderer/sidechat/useChat', () => ({ useConversationPanel: () => ({}) }))
vi.mock('../src/renderer/sidechat/usePreviewAsk', () => ({ usePreviewAsk: () => ({ clearQuote, selection: null }), PreviewAskOffer: () => null }))
const { clearQuote } = vi.hoisted(() => ({ clearQuote: () => {} }))
let changeBody: (text: string) => void, contextRequest: (request: CoachContextRequest) => void
const contextReply = vi.fn()
let root: Root, container: HTMLDivElement, notebook: WritingNotebook
let pages: Record<string, WritingNotebookPage>, flushRequest: (request: string) => void
const rename = vi.fn(), flushed = vi.fn(), deletePage = vi.fn(), remove = vi.fn()
const title = () => container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
const edit = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title(), value)
  title().dispatchEvent(new Event('input', { bubbles: true }))
})
const key = async (value: string) => act(async () => { title().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })) })
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.getAnimations = () => []
  rename.mockReset(); flushed.mockReset(); deletePage.mockReset(); remove.mockReset()
  notebook = { id: 'notebook', version: 1, title: 'Fixed notebook', pages: [{ id: 'one', title: 'First page' }, { id: 'two', title: 'Second page' }], selectedPageId: 'one', textScale: 1, chatOpen: false, createdAt: '', updatedAt: '', lastAccessedAt: '' }
  pages = Object.fromEntries(notebook.pages.map(page => [page.id, { ...page, markdown: 'Body', revision: 0, updatedAt: '' }]))
  rename.mockImplementation(async (_id: string, pageId: string, name: string) => {
    notebook.pages.find(page => page.id === pageId)!.title = name
    pages[pageId]!.title = name
    return structuredClone(notebook)
  })
  deletePage.mockImplementation(async (_id: string, pageId: string) => {
    notebook.pages = notebook.pages.filter(page => page.id !== pageId)
    delete pages[pageId]
    if (notebook.selectedPageId === pageId) notebook.selectedPageId = notebook.pages[0]!.id
    return structuredClone(notebook)
  })
  Object.defineProperty(window, 'opencourse', { configurable: true, value: { onCoachContextRequest: (handler: typeof contextRequest) => { contextRequest = handler; return () => {} }, replyCoachContext: contextReply, writing: {
    get: async () => structuredClone(notebook), page: async (_id: string, pageId: string) => structuredClone(pages[pageId]),
    update: async (_id: string, patch: Partial<WritingNotebook>) => { Object.assign(notebook, patch); return structuredClone(notebook) },
    renamePage: rename, deletePage, remove, chat: {}, ready: () => {}, flushed,
    onSelectPage: () => () => {}, onFlush: (callback: typeof flushRequest) => { flushRequest = callback; return () => {} }, onSave: () => () => {}, onResume: () => () => {},
  } } })
  container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
  await act(async () => { root.render(h(NotebookWindow, { id: 'notebook' })) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('autosaves the heading and updates the sidebar without a dialog', async () => {
  await act(async () => title().focus()); await edit('A new title')
  expect(container.querySelector('.writing-page-link')!.textContent).toBe('A new title')
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(rename).toHaveBeenCalledWith('notebook', 'one', 'A new title')
  expect(title().value).toBe('A new title'); expect(document.activeElement).toBe(title())
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Saved')
})
it('restores the starting title on Escape and gives empty titles a fallback on Enter', async () => {
  await act(async () => title().focus()); await edit('Temporary')
  await act(async () => vi.advanceTimersByTimeAsync(500)); await key('Escape')
  expect(title().value).toBe('First page'); expect(pages.one!.title).toBe('First page')
  await act(async () => title().focus()); await edit('   '); await key('Enter')
  expect(title().value).toBe('Untitled page'); expect(pages.one!.title).toBe('Untitled page')
})
it('flushes a pending title before switching pages or closing the window', async () => {
  await edit('Before switching')
  await act(async () => { (container.querySelectorAll('.writing-page-link')[1] as HTMLButtonElement).click() })
  expect(pages.one!.title).toBe('Before switching'); expect(title().value).toBe('Second page')
  await edit('Before closing'); await act(async () => flushRequest('request'))
  expect(pages.two!.title).toBe('Before closing'); expect(flushed).toHaveBeenCalledWith('request', true)
})
it('retains a failed title edit for retry instead of reporting it saved', async () => {
  rename.mockRejectedValueOnce(new Error('Disk unavailable'))
  await edit('Retry this title'); await act(async () => flushRequest('request'))
  expect(flushed).toHaveBeenCalledWith('request', false); expect(title().value).toBe('Retry this title')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Not saved')
  await act(async () => { (container.querySelector('.writing-error button') as HTMLButtonElement).click() })
  expect(pages.one!.title).toBe('Retry this title')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Saved')
})
it('deletes the right-clicked page only after confirmation and protects the final page', async () => {
  const card = container.querySelectorAll('.writing-page-link')[1]!
  await act(async () => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 })) })
  expect(title().value).toBe('First page')
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Delete page')
  await act(async () => { (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click() })
  expect(deletePage).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Second page')
  await act(async () => { (container.querySelector('.dialog-confirm') as HTMLButtonElement).click() })
  expect(deletePage).toHaveBeenCalledWith('notebook', 'two')
  expect(title().value).toBe('First page')
  await act(async () => { container.querySelector('.writing-page-link')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 })) })
  const lastPageDelete = document.querySelector('[role="menuitem"]') as HTMLButtonElement
  expect(lastPageDelete.disabled).toBe(true)
  expect(lastPageDelete.textContent).toContain('Keep at least one page')
})
it('puts notebook deletion below New page and dismisses the context menu outside', async () => {
  expect(container.querySelector('[aria-label="Notebook actions"]')).toBeNull()
  const button = container.querySelector('.writing-delete-notebook') as HTMLButtonElement
  expect(button.previousElementSibling?.classList.contains('writing-new-page')).toBe(true)
  await act(async () => { container.querySelector('.writing-page-link')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 })) })
  await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => button.click())
  expect(remove).not.toHaveBeenCalled()
  await act(async () => { (container.querySelector('.dialog-confirm') as HTMLButtonElement).click() })
  expect(remove).toHaveBeenCalledWith('notebook')
})
it('offers default layout settings beside Saved and saves changes to the notebook', async () => {
  const options = container.querySelector<HTMLButtonElement>('[aria-label="Notebook options"]')!
  expect(options.previousElementSibling?.getAttribute('role')).toBe('status')
  await act(async () => options.click())
  const numbers = document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!
  expect(numbers.getAttribute('aria-checked')).toBe('false')
  const layouts = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(layouts.map(item => [item.textContent, item.getAttribute('aria-checked')])).toEqual([['Wide text', 'true'], ['Thin text', 'false']])
  await act(async () => numbers.click())
  expect(notebook.showLineNumbers).toBe(true)
  await act(async () => options.click())
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(item => item.textContent === 'Thin text')!.click() })
  expect(notebook.textLayout).toBe('thin')
})

it('lets the coach inspect and read unsaved open pages and follows page switches', async () => {
  const request = (tool: CoachContextRequest['tool'], args = {}) => contextRequest({ requestId: 'context', userId: 'learner', tool, args })
  await act(async () => changeBody('Unsaved notebook passage'))
  request('get_app_context')
  expect(contextReply.mock.lastCall?.[1]).toMatchObject({ entries: [{ kind: 'writing-notebook', notebookId: 'notebook', pageId: 'one', excerpt: 'Unsaved notebook passage', unsaved: true }] })
  request('read_notebook_page', { notebook_id: 'notebook', page_id: 'one', offset: 8 })
  expect(contextReply.mock.lastCall?.[1]).toMatchObject({ value: { text: 'notebook passage', unsaved: true, state: 'open editor' } })
  expect(pages.one!.markdown).toBe('Body')
  // Restore the original text so switching pages requires no save in this title fixture.
  await act(async () => changeBody('Body'))
  await act(async () => { (container.querySelectorAll('.writing-page-link')[1] as HTMLButtonElement).click() })
  request('get_app_context')
  expect(contextReply.mock.lastCall?.[1]).toMatchObject({ entries: [{ pageId: 'two', unsaved: false }] })
  request('read_notebook_page', { notebook_id: 'notebook', page_id: 'one', offset: 0 })
  expect(contextReply.mock.lastCall?.[1]).toEqual({})
})
