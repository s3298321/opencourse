import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentView } from '../src/core/documents/types'
import DocumentReader from '../src/renderer/routes/Document'
import { ScreenHost } from '../src/renderer/screen-activity'

const pdfState = vi.hoisted(() => ({ pdf: null as { numPages: number } | null }))
vi.mock('../src/renderer/documents/usePdf', () => ({ usePdf: () => ({ pdf: pdfState.pdf, error: null, unlock: null }) }))
vi.mock('../src/renderer/documents/PdfPage', () => ({ default: ({ number, top }: { number: number; top: number }) => h('div', { 'data-pdf-page': number, style: { top } }) }))
vi.mock('../src/renderer/documents/useDocumentChat', () => ({ useDocumentChat: () => ({}) }))
vi.mock('../src/renderer/components/ChatPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))

let root: Root, container: HTMLDivElement
let documents: Map<string, DocumentView>
let changed: (id: string) => void
const getDocument = vi.fn<(id: string) => Promise<DocumentView>>()
const savePage = vi.fn<(id: string, page: number) => Promise<void>>()
const view = (id: string, lastPage: number): DocumentView => ({
  id, lastPage, title: id, bytes: 1000, fingerprint: id, pages: 10, indexedPages: 10, searchablePages: 10,
  status: 'ready', error: null, completed: false, createdAt: 'now', sections: []
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  pdfState.pdf = { numPages: 10 }
  documents = new Map([['first', view('first', 3)], ['second', view('second', 7)]])
  getDocument.mockReset().mockImplementation(async id => ({ ...documents.get(id)! }))
  savePage.mockReset().mockImplementation(async (id, page) => { documents.get(id)!.lastPage = page })
  vi.stubGlobal('opencourse', {
    getDocument, setDocumentPage: savePage,
    onDocumentsChanged: (handler: (id: string) => void) => { changed = handler; return () => {} }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren(); vi.unstubAllGlobals()
})
const render = async (id = 'first', active = true) => act(async () => root.render(h(ScreenHost, { active }, h(DocumentReader, {
  key: id, documentId: id, user: null, route: { name: 'document', documentId: id },
  navigate: () => {}, navSignal: null, findSignal: 0
}))))
const currentPage = () => Number(container.querySelector<HTMLInputElement>('#document-page')!.value)
const scroller = () => container.querySelector<HTMLDivElement>('.pdf-scroll')!
async function scrollToPage(number: number) {
  const target = container.querySelector<HTMLDivElement>(`[data-pdf-page="${number}"]`)!
  await act(async () => {
    scroller().scrollTop = Number.parseFloat(target.style.top) - 24
    scroller().dispatchEvent(new Event('scroll'))
  })
}
describe('document reading position', () => {
  it('restores the saved page and saves scrolling and page navigation for the next open', async () => {
    await render()
    expect(currentPage()).toBe(3)
    expect(scroller().scrollTop).toBeGreaterThan(0)
    expect(savePage).not.toHaveBeenCalled()
    await scrollToPage(5)
    expect(savePage).toHaveBeenLastCalledWith('first', 5)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click())
    expect(savePage).toHaveBeenLastCalledWith('first', 6)
    await act(async () => root.render(null))
    await render()
    expect(currentPage()).toBe(6)
    const target = container.querySelector<HTMLDivElement>('[data-pdf-page="6"]')!
    expect(scroller().scrollTop).toBe(Number.parseFloat(target.style.top) - 24)
  })
  it('waits for both metadata and the PDF without overwriting the saved page', async () => {
    let resolve!: (document: DocumentView) => void
    getDocument.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    pdfState.pdf = null
    await render()
    await act(async () => scroller().dispatchEvent(new Event('scroll')))
    expect(savePage).not.toHaveBeenCalled()
    await act(async () => resolve(view('first', 8)))
    expect(currentPage()).toBe(1)
    expect(savePage).not.toHaveBeenCalled()
    pdfState.pdf = { numPages: 10 }
    await render()
    expect(currentPage()).toBe(8)
    expect(savePage).not.toHaveBeenCalled()
  })
  it('saves the final page even when leaving before the scroll update renders', async () => {
    await render()
    const target = container.querySelector<HTMLDivElement>('[data-pdf-page="4"]')!
    await act(async () => {
      scroller().scrollTop = Number.parseFloat(target.style.top) - 24
      scroller().dispatchEvent(new Event('scroll'))
      root.render(null)
    })
    expect(savePage).toHaveBeenLastCalledWith('first', 4)
    await render()
    expect(currentPage()).toBe(4)
  })
  it('keeps separate positions and does not reset the page on metadata refresh', async () => {
    await render()
    await scrollToPage(4)
    documents.get('first')!.lastPage = 1
    await act(async () => changed('first'))
    expect(currentPage()).toBe(4)
    await render('second')
    expect(currentPage()).toBe(7)
    expect(savePage).toHaveBeenCalledTimes(1)
    await scrollToPage(8)
    expect(savePage).toHaveBeenLastCalledWith('second', 8)
  })
  it('ignores scroll events while the reader is parked in another workspace', async () => {
    await render()
    await render('first', false)
    await act(async () => { scroller().scrollTop = 0; scroller().dispatchEvent(new Event('scroll')) })
    expect(currentPage()).toBe(3)
    expect(savePage).not.toHaveBeenCalled()
    await render()
    expect(currentPage()).toBe(3)
    expect(scroller().scrollTop).toBeGreaterThan(0)
  })
  it('bounds the saved page using the PDF page count', async () => {
    pdfState.pdf = { numPages: 2 }
    await render()
    expect(currentPage()).toBe(2)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled).toBe(true)
  })
})
