import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '../src/core/documents/types'
import Documents from '../src/renderer/routes/Documents'

vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
let root: Root, container: HTMLDivElement, documents: DocumentSummary[], changed: () => void
const summary = (id: string, readPage: number, pages = 10): DocumentSummary => ({
  id, title: id, readPage, pages, bytes: 1000, fingerprint: id, indexedPages: pages, searchablePages: pages,
  status: 'ready', error: null, createdAt: 'now'
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  documents = [summary('Unread', 0), summary('Partial', 3), summary('Almost', 999, 1000), summary('Finished', 10), summary('Unknown pages', 0, 0)]
  vi.stubGlobal('opencourse', {
    listDocuments: async () => documents.map(document => ({ ...document })),
    onDocumentsChanged: (handler: () => void) => { changed = handler; return () => {} }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(h(Documents, {
  user: null, route: { name: 'documents' }, navigate: vi.fn(), importSignal: 0, onImportHandled: vi.fn()
})))
const filter = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const titles = () => [...container.querySelectorAll('.document-card h3')].map(heading => heading.textContent)
describe('PDF library progress', () => {
  it('shows reading percentages and filters completed PDFs using exactly 100% progress', async () => {
    await render()
    expect(container.textContent).not.toMatch(/Mark completed|Mark incomplete/)
    expect([...container.querySelectorAll('.document-card-actions button')].map(button => button.textContent)).toEqual(Array(5).fill('Remove'))
    const cards = [...container.querySelectorAll('.document-card-open')].map(card => card.textContent)
    expect(cards[0]).toContain('0% read')
    expect(cards[1]).toContain('30% read')
    expect(cards[2]).toContain('99% read')
    expect(cards[3]).toContain('100% read')
    await act(async () => filter('Completed').click())
    expect(titles()).toEqual(['Finished'])
    await act(async () => filter('To read').click())
    expect(titles()).toEqual(['Unread', 'Partial', 'Almost', 'Unknown pages'])
    await act(async () => filter('To read').click())
    expect(titles()).toHaveLength(5)
  })
  it('updates filters when marked progress reaches the final page or moves backward', async () => {
    await render()
    await act(async () => filter('Completed').click())
    documents[1]!.readPage = 10
    await act(async () => changed())
    expect(titles()).toEqual(['Partial', 'Finished'])
    documents[3]!.readPage = 2
    await act(async () => changed())
    expect(titles()).toEqual(['Partial'])
    await act(async () => filter('To read').click())
    expect(titles()).toContain('Finished')
  })
})
