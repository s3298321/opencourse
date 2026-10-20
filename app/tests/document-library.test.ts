import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary } from '../src/core/documents/types'
import type { ServerConnection } from '../src/core/types'
import Documents from '../src/renderer/routes/Documents'

vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
let root: Root, container: HTMLDivElement, documents: DocumentSummary[], changed: () => void, servers: ServerConnection[]
const summary = (id: string, readPage: number, pages = 10): DocumentSummary => ({
  id, title: id, readPage, pages, bytes: 1000, fingerprint: id, indexedPages: pages, searchablePages: pages,
  status: 'ready', error: null, createdAt: 'now'
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  documents = [summary('Unread', 0), summary('Partial', 3), summary('Almost', 999, 1000), summary('Finished', 10), summary('Unknown pages', 0, 0)]
  servers = []
  vi.stubGlobal('opencourse', {
    listDocuments: async () => documents.map(document => ({ ...document })),
    onDocumentsChanged: (handler: () => void) => { changed = handler; return () => {} },
    listServers: async () => servers,
    onServersChanged: () => () => {},
    checkDocumentUpdates: async () => ({ 'Field guide': { kind: 'update', version: '2.0.0' } })
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
    expect(container.querySelectorAll('.document-card button')).toHaveLength(5)
    expect(container.textContent).not.toMatch(/Remove|Delete/)
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
describe('PDF library sources', () => {
  it('keeps a server copy under its server, with its version and update, and offers that server’s catalog', async () => {
    servers = [{ id: 'srv', url: 'https://catalog.example', name: 'Catalog', description: '', account: { id: 'a', username: 'reader', email: 'r@example.com' }, active: true, status: 'online', capabilities: ['documents-v1'] }]
    documents = [summary('Local one', 0), { ...summary('Field guide', 0), origin: { connectionId: 'srv', name: 'Catalog', version: '1.0.0', remoteId: 'remote' } }]
    const navigate = vi.fn()
    await act(async () => root.render(h(Documents, { user: null, route: { name: 'documents' }, navigate, importSignal: 0, onImportHandled: vi.fn() })))
    expect(titles()).toEqual(['Local one'])
    expect(container.querySelector('[aria-label="Add documents"]')).toBeNull()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.firstChild?.textContent)).toEqual(['Local', 'Catalog'])
    await act(async () => tabs[1]!.click())
    expect(titles()).toEqual(['Field guide'])
    const card = container.querySelector('.document-card')!.textContent
    expect(card).toContain('v1.0.0')
    expect(card).toContain('Update to v2.0.0')
    expect(container.querySelectorAll('.document-card button')).toHaveLength(1)
    expect(card).not.toMatch(/Remove|Delete/)
    await act(async () => container.querySelector<HTMLButtonElement>('.document-card-open')!.click())
    expect(navigate).toHaveBeenCalledWith({ name: 'documentOverview', documentId: 'Field guide' })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add documents"]')!.click())
    expect(navigate).toHaveBeenCalledWith({ name: 'documentCatalog', serverId: 'srv' })
  })
})
