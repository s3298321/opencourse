import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentView } from '../src/core/documents/types'
import DocumentOverview from '../src/renderer/routes/DocumentOverview'

vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
let root: Root, container: HTMLDivElement, doc: DocumentView
const navigate = vi.fn()
const removeDocument = vi.fn()
const leaveServerDocument = vi.fn()
const removeLearningDownload = vi.fn()
const confirm = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  doc = { id: 'doc', title: 'Field guide', readPage: 0, lastPage: 1, pages: 8, bytes: 1000, fingerprint: 'pdf', indexedPages: 8, searchablePages: 8, status: 'ready', error: null, createdAt: 'now', sections: [] }
  navigate.mockReset()
  removeDocument.mockReset().mockResolvedValue(undefined)
  leaveServerDocument.mockReset().mockResolvedValue({ ok: true })
  removeLearningDownload.mockReset().mockResolvedValue(undefined)
  confirm.mockReset().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
  vi.stubGlobal('opencourse', {
    getDocument: async () => doc,
    documentPublication: async () => ({ description: '', tags: [], version: '1.0.0', publications: {} }),
    documentCoverPreview: async () => null,
    getDocumentCatalogCover: async () => null,
    onDocumentsChanged: () => () => {},
    listServers: async () => [],
    onServersChanged: () => () => {},
    checkDocumentUpdates: async () => ({}),
    removeDocument, leaveServerDocument, removeLearningDownload
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(h(DocumentOverview, { documentId: doc.id, user: null, navigate, route: { name: 'documentOverview', documentId: doc.id } })))
const button = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label)!

describe('document presentation removal', () => {
  it.each([false, true])('confirms and removes the appropriate local/server document (server: %s)', async (server) => {
    if (server) doc.origin = { connectionId: 'srv', name: 'Catalog', version: '1.0.0', remoteId: 'remote' }
    await render()
    const label = server ? 'Remove from My learning' : 'Delete document'
    expect(button(server ? 'Delete document' : 'Remove from My learning')).toBeUndefined()
    confirm.mockReturnValue(false)
    await act(async () => button(label).click())
    expect(removeDocument).not.toHaveBeenCalled()
    expect(leaveServerDocument).not.toHaveBeenCalled()
    expect(removeLearningDownload).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await act(async () => button(label).click())
    if (server) {
      expect(leaveServerDocument).toHaveBeenCalledWith('doc')
      expect(removeLearningDownload).toHaveBeenCalledWith('doc')
      expect(removeDocument).not.toHaveBeenCalled()
    } else {
      expect(removeDocument).toHaveBeenCalledWith('doc')
      expect(leaveServerDocument).not.toHaveBeenCalled()
      expect(removeLearningDownload).not.toHaveBeenCalled()
    }
    expect(navigate).toHaveBeenCalledWith({ name: 'documents', source: server ? 'srv' : 'local' })
  })

  it('keeps the local document page open and reports deletion errors', async () => {
    removeDocument.mockRejectedValue(new Error('Could not delete document'))
    await render()
    await act(async () => button('Delete document').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not delete document')
    expect(navigate).not.toHaveBeenCalled()
    expect(button('Delete document').disabled).toBe(false)
  })

  it('keeps the download when removal from My learning fails', async () => {
    doc.origin = { connectionId: 'srv', name: 'Catalog', version: '1.0.0', remoteId: 'remote' }
    leaveServerDocument.mockResolvedValue({ ok: false, message: 'Server unavailable' })
    await render()
    await act(async () => button('Remove from My learning').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Server unavailable')
    expect(removeLearningDownload).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
