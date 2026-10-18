import { act, createElement as h, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentView } from '../src/core/documents/types'
import DocumentReader from '../src/renderer/routes/Document'
import { ScreenHost } from '../src/renderer/screen-activity'

const pdfState = vi.hoisted(() => ({ pdf: null as { numPages: number } | null, sizes: {} as Record<number, { width: number; height: number }> }))
vi.mock('../src/renderer/documents/usePdf', () => ({ usePdf: () => ({ pdf: pdfState.pdf, error: null, unlock: null }) }))
vi.mock('../src/renderer/documents/PdfPage', () => ({ default: ({ number, top, scale, measured }: { number: number; top: number; scale: number; measured: (page: number, width: number, height: number) => void }) => {
  useEffect(() => {
    const size = pdfState.sizes[number]
    if (size) measured(number, size.width, size.height)
  }, [number, measured])
  return h('div', { 'data-pdf-page': number, 'data-scale': scale, style: { top, width: (pdfState.sizes[number]?.width ?? 612) * scale } })
} }))
vi.mock('../src/renderer/documents/useDocumentChat', () => ({ useDocumentChat: () => ({}) }))
vi.mock('../src/renderer/components/ChatPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))

let root: Root, container: HTMLDivElement
let documents: Map<string, DocumentView>
let changed: (id: string) => void
const getDocument = vi.fn<(id: string) => Promise<DocumentView>>()
const savePage = vi.fn<(id: string, page: number) => Promise<void>>()
const saveProgress = vi.fn<(id: string, page: number) => Promise<DocumentView>>()
const view = (id: string, lastPage: number): DocumentView => ({
  id, lastPage, readPage: 0, title: id, bytes: 1000, fingerprint: id, pages: 10, indexedPages: 10, searchablePages: 10,
  status: 'ready', error: null, createdAt: 'now', sections: []
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  pdfState.pdf = { numPages: 10 }
  pdfState.sizes = {}
  documents = new Map([['first', view('first', 3)], ['second', view('second', 7)]])
  getDocument.mockReset().mockImplementation(async id => ({ ...documents.get(id)! }))
  savePage.mockReset().mockImplementation(async (id, page) => { documents.get(id)!.lastPage = page })
  saveProgress.mockReset().mockImplementation(async (id, page) => {
    documents.get(id)!.readPage = page
    return { ...documents.get(id)! }
  })
  vi.stubGlobal('opencourse', {
    getDocument, setDocumentPage: savePage, setDocumentProgress: saveProgress,
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
describe('manual document reading progress', () => {
  const progress = () => container.querySelector<HTMLProgressElement>('[aria-label="Reading progress"]')!
  const mark = () => container.querySelector<HTMLButtonElement>('.document-reading-progress .action-button')!
  const resume = () => container.querySelector<HTMLButtonElement>('[aria-label="Go to last read page"]')!
  it('only updates when marked, persists on reopen, and can move backward', async () => {
    await render()
    expect(currentPage()).toBe(3)
    expect(container.querySelector('.document-sidebar')!.textContent).not.toMatch(/Mark completed|Mark incomplete/)
    expect(progress().value).toBe(0)
    expect(resume().disabled).toBe(true)
    expect(progress().max).toBe(10)
    expect(container.querySelector('.document-progress-percent')!.textContent).toBe('0%')
    const toolbar = container.querySelector('.document-toolbar')!
    expect([...toolbar.children].indexOf(progress().closest('.document-reading-progress')!)).toBeGreaterThan([...toolbar.children].indexOf(container.querySelector('#document-page')!.parentElement!))
    expect([...toolbar.children].indexOf(progress().closest('.document-reading-progress')!)).toBeLessThan([...toolbar.children].indexOf(container.querySelector('[aria-label="Zoom out"]')!))
    await act(async () => mark().click())
    expect(saveProgress).toHaveBeenLastCalledWith('first', 3)
    expect(progress().value).toBe(3)
    expect(container.querySelector('.document-progress-percent')!.textContent).toBe('30%')
    await scrollToPage(5)
    expect(progress().value).toBe(3)
    expect(saveProgress).toHaveBeenCalledTimes(1)
    await act(async () => changed('first'))
    expect(progress().value).toBe(3)
    await act(async () => root.render(null))
    await render()
    expect(currentPage()).toBe(5)
    expect(progress().value).toBe(3)
    expect(resume().disabled).toBe(false)
    await act(async () => resume().click())
    expect(currentPage()).toBe(3)
    expect(savePage).toHaveBeenLastCalledWith('first', 3)
    expect(saveProgress).toHaveBeenCalledTimes(1)
    await scrollToPage(3)
    await scrollToPage(2)
    await act(async () => mark().click())
    expect(progress().value).toBe(2)
    expect(saveProgress).toHaveBeenLastCalledWith('first', 2)
    await render('second')
    expect(progress().value).toBe(0)
    await render('first')
    expect(progress().value).toBe(2)
  })
  it('reaches 100% when the last page is explicitly marked', async () => {
    documents.get('first')!.lastPage = 10
    await render()
    expect(progress().value).toBe(0)
    await act(async () => mark().click())
    expect(progress().value).toBe(10)
    expect(container.querySelector('.document-progress-percent')!.textContent).toBe('100%')
    expect(progress().getAttribute('aria-valuetext')).toBe('Read through page 10 of 10')
  })
  it('keeps saved progress when saving fails and permits retrying', async () => {
    documents.get('first')!.readPage = 1
    saveProgress.mockRejectedValueOnce(new Error('Could not save progress.'))
    await render()
    await act(async () => mark().click())
    expect(progress().value).toBe(1)
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Could not save progress.')
    expect(mark().disabled).toBe(false)
    await act(async () => mark().click())
    expect(progress().value).toBe(3)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it('disables marking until the PDF and restored position are ready', async () => {
    pdfState.pdf = null
    documents.get('first')!.pages = 0
    await render()
    expect(mark().disabled).toBe(true)
    expect(container.querySelector('.document-progress-percent')!.textContent).toBe('0%')
    expect(saveProgress).not.toHaveBeenCalled()
    pdfState.pdf = { numPages: 10 }
    await render()
    expect(mark().disabled).toBe(false)
    await act(async () => mark().click())
    expect(saveProgress).toHaveBeenLastCalledWith('first', 3)
  })
})
describe('document heading outline', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    documents.get('first')!.lastPage = 1
    documents.get('first')!.sections = [
      { id: 'chapter', title: 'Chapter', page: 1, depth: 0 },
      { id: 'section', title: 'Section', page: 2, depth: 1 },
      { id: 'detail', title: 'Detail', page: 3, top: 120, depth: 3 },
      { id: 'sibling', title: 'Sibling', page: 4, depth: 1 },
      { id: 'other', title: 'Other chapter', page: 5, depth: 0 }
    ]
  })
  afterEach(() => vi.restoreAllMocks())
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  const heading = (title: string) => container.querySelector<HTMLButtonElement>(`.document-section[title="${title}"]`)!
  const visible = (title: string) => !heading(title).closest('[hidden]')
  const action = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.document-outline-actions button')].find(button => button.textContent === label)!
  it.each([{ scrollHeight: 1200, expectedTop: 600 }, { scrollHeight: 550, expectedTop: 350 }])('reveals and aligns the marked page heading within a $scrollHeight-pixel outline', async ({ scrollHeight, expectedTop }) => {
    const document = documents.get('first')!
    document.lastPage = 5; document.readPage = 3
    document.sections[2]!.top = 0
    document.sections.push({ id: 'other-detail', title: 'Other detail', page: 6, depth: 1 })
    await render()
    const sidebar = container.querySelector<HTMLElement>('.document-outline-scroll')!
    expect(container.querySelector('.document-sidebar')!.textContent).not.toContain('LOCAL PDF')
    expect(container.querySelector('.document-sidebar-head')!.closest('.document-outline-scroll')).toBeNull()
    expect(container.querySelector('.document-outline-actions')!.closest('.document-outline-scroll')).toBeNull()
    const row = heading('Detail').closest<HTMLElement>('.document-section-row')!
    Object.defineProperties(sidebar, { scrollHeight: { value: scrollHeight }, clientHeight: { value: 200 } })
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      expect(row.closest('[hidden]')).toBeNull()
      return { top: 100 + 600 - sidebar.scrollTop } as DOMRect
    })
    sidebar.scrollTop = 150
    await act(async () => action('Collapse all').click())
    await act(async () => button('Go to last read page').click())
    expect(currentPage()).toBe(3)
    expect(visible('Detail')).toBe(true)
    expect(visible('Other detail')).toBe(false)
    expect(sidebar.scrollTop).toBe(expectedTop)
    expect(container.querySelector('.document-sidebar')!.scrollTop).toBe(0)
    const pdfTop = scroller().scrollTop
    // Clicking again realigns an already visible heading without moving the PDF differently.
    sidebar.scrollTop = 25
    await act(async () => button('Go to last read page').click())
    expect(sidebar.scrollTop).toBe(expectedTop)
    expect(scroller().scrollTop).toBe(pdfTop)
    // Collapsing the current section's ancestors must not defeat a repeated jump.
    await act(async () => action('Collapse all').click())
    expect(visible('Detail')).toBe(false)
    await act(async () => button('Go to last read page').click())
    expect(visible('Detail')).toBe(true)
    expect(sidebar.scrollTop).toBe(expectedTop)
    expect(saveProgress).not.toHaveBeenCalled()
    sidebar.scrollTop = 25
    await act(async () => changed('first'))
    expect(sidebar.scrollTop).toBe(25)
  })
  it('collapses nested branches independently without navigating, and preserves them on refresh', async () => {
    await render()
    expect(button('Collapse Detail')).toBeNull()
    await act(async () => button('Collapse Section').click())
    expect(visible('Detail')).toBe(false)
    expect(visible('Sibling')).toBe(true)
    await act(async () => button('Collapse Chapter').click())
    expect(visible('Section')).toBe(false)
    expect(visible('Other chapter')).toBe(true)
    expect(currentPage()).toBe(1)
    expect(savePage).not.toHaveBeenCalled()
    documents.get('first')!.sections = documents.get('first')!.sections.map(section => ({ ...section }))
    await act(async () => changed('first'))
    expect(button('Expand Chapter').getAttribute('aria-expanded')).toBe('false')
    await act(async () => button('Expand Chapter').click())
    expect(visible('Section')).toBe(true)
    expect(visible('Detail')).toBe(false)
    await act(async () => button('Expand Section').click())
    await act(async () => heading('Detail').click())
    expect(currentPage()).toBe(3)
    expect(heading('Detail').getAttribute('aria-current')).toBe('location')
    expect(scroller().scrollTop).toBeGreaterThan(Number.parseFloat(container.querySelector<HTMLElement>('[data-pdf-page="3"]')!.style.top) - 24)
  })
  it('expands and collapses all levels, and reveals the current section when navigating', async () => {
    await render()
    expect(action('Expand all').disabled).toBe(true)
    await act(async () => action('Collapse all').click())
    expect(visible('Section')).toBe(false)
    expect(action('Collapse all').disabled).toBe(true)
    await act(async () => action('Expand all').click())
    expect(visible('Detail')).toBe(true)
    await act(async () => action('Collapse all').click())
    await scrollToPage(2)
    expect(visible('Section')).toBe(true)
    expect(visible('Detail')).toBe(false)
    await scrollToPage(4)
    await scrollToPage(3)
    await act(async () => {
      const target = container.querySelector<HTMLElement>('[data-pdf-page="3"]')!
      scroller().scrollTop = Number.parseFloat(target.style.top) + 120 * Number(target.getAttribute('data-scale'))
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(visible('Detail')).toBe(true)
    expect(button('Collapse Section').getAttribute('aria-expanded')).toBe('true')
  })
  it('preserves bookmark hierarchy even when destinations are out of page order', async () => {
    documents.get('first')!.sections[1]!.page = 6
    await render()
    await act(async () => button('Collapse Section').click())
    expect(visible('Detail')).toBe(false)
    expect(visible('Sibling')).toBe(true)
    expect(visible('Other chapter')).toBe(true)
  })
})
describe('document zoom', () => {
  it.each([1, 7])('fits mixed page widths when opening on page %i and keeps fitting after resize', async lastPage => {
    let paneWidth = 800, resize!: () => void
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => paneWidth)
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
    try {
      documents.get('first')!.lastPage = lastPage
      for (let page = 1; page <= 10; page++) pdfState.sizes[page] = { width: page === 1 ? 400 : page % 2 ? 900 : 620, height: 1000 }
      await render()
      const assertFits = () => {
        expect(Number.parseFloat(container.querySelector<HTMLElement>('.pdf-pages')!.style.width)).toBe(paneWidth)
        for (const page of container.querySelectorAll<HTMLElement>('[data-pdf-page]')) expect(Number.parseFloat(page.style.width)).toBeCloseTo(paneWidth - 48)
      }
      assertFits()
      expect(currentPage()).toBe(lastPage)
      if (lastPage === 7) expect(container.querySelector('[data-pdf-page="1"]')).toBeNull()
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click())
      expect(Number.parseFloat(container.querySelector<HTMLElement>('.pdf-pages')!.style.width)).toBeGreaterThan(paneWidth)
      scroller().scrollLeft = 120
      await act(async () => container.querySelector<HTMLButtonElement>('[title="Fit page width"]')!.click())
      assertFits()
      expect(scroller().scrollLeft).toBe(0)
      expect(currentPage()).toBe(lastPage)
      // Fit also clears horizontal panning when the displayed zoom is already 100%.
      scroller().scrollLeft = 40
      await act(async () => container.querySelector<HTMLButtonElement>('[title="Fit page width"]')!.click())
      expect(scroller().scrollLeft).toBe(0)
      paneWidth = 600
      await act(async () => resize())
      assertFits()
      expect(currentPage()).toBe(lastPage)
      const target = lastPage === 1 ? 2 : 8
      documents.get('first')!.sections = [{ id: 'target', title: 'Target heading', page: target, depth: 0, top: 100 }]
      await act(async () => changed('first'))
      await act(async () => container.querySelector<HTMLButtonElement>('.document-section[title="Target heading"]')!.click())
      expect(currentPage()).toBe(target)
      const targetPage = container.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`)!
      expect(scroller().scrollTop).toBeCloseTo(Number.parseFloat(targetPage.style.top) + 100 * Number(targetPage.dataset.scale) - 24)
      assertFits()
    } finally { width.mockRestore() }
  })
  it('keeps shrinking below 50% and the old render minimum, and supports zooming back in and fitting', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    try {
      await render()
      const out = container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!
      const fit = container.querySelector<HTMLButtonElement>('[title="Fit page width"]')!
      const zoomIn = container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
      const scale = () => Number(container.querySelector('[data-pdf-page]')!.getAttribute('data-scale'))
      for (const label of ['75%', '50%', '40%', '30%', '25%', '20%', '15%', '10%', '5%', '2.5%']) {
        const previous = scale()
        expect(out.disabled).toBe(false)
        await act(async () => out.click())
        expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe(label)
        expect(scale()).toBeGreaterThan(0)
        expect(scale()).toBeLessThan(previous)
      }
      expect(scale()).toBeLessThan(0.2)
      await act(async () => zoomIn.click())
      expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('5%')
      for (const label of ['10%', '15%', '20%', '25%', '30%', '40%', '50%', '75%', '100%']) {
        await act(async () => zoomIn.click())
        expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe(label)
      }
      await act(async () => out.click())
      await act(async () => fit.click())
      expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('100%')
      expect(scale()).toBeCloseTo((800 - 48) / 612)
    } finally { width.mockRestore() }
  })
  async function editZoom(value: string, key?: string) {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit zoom percentage"]')!.click())
    const input = container.querySelector<HTMLInputElement>('[aria-label="Zoom percentage"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      input.value = value
      if (key) input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      else input.blur()
    })
  }
  it('applies a custom percentage on Enter or blur and cancels with Escape', async () => {
    await render()
    const scale = () => Number(container.querySelector('[data-pdf-page]')!.getAttribute('data-scale'))
    const original = scale()
    await editZoom('42.5', 'Enter')
    expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('42.5%')
    expect(scale()).toBeCloseTo(original * 0.425)
    await editZoom(' 12.75% ')
    expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('12.75%')
    await editZoom('80', 'Escape')
    expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('12.75%')
    expect(scale()).toBeCloseTo(original * 0.1275)
  })
  it.each(['', ' ', 'abc', '42oops', '0', '-10', '301', 'Infinity', 'NaN', '0x10'])('keeps the current zoom for invalid input %j', async value => {
    await render()
    await editZoom('35')
    const previous = container.querySelector('[data-pdf-page]')!.getAttribute('data-scale')
    await editZoom(value, 'Enter')
    expect(container.querySelector('[aria-label="Edit zoom percentage"]')!.textContent).toBe('35%')
    expect(container.querySelector('[data-pdf-page]')!.getAttribute('data-scale')).toBe(previous)
  })
})
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
