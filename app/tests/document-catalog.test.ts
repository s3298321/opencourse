// @vitest-environment node
// A document's life on a server, through the app's own main-side code against
// an in-process server: publish from the library, browse, add, read on two
// sides with one progress, update, unlist and manage - the course journey for a PDF.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { LearningState } from '../src/core/learning/types'
import { fixturePdf } from './helpers/pdf'
import { makeZip } from './helpers/zip'

const root = mkdtempSync(join(tmpdir(), 'opencourse-document-catalog-test-'))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(root, name), getAppPath: () => resolve('.'), isPackaged: false, on: () => {} },
  dialog: {},
  BrowserWindow: { getFocusedWindow: () => null },
  net: { fetch: () => { throw Error('injected') } },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  const { stopLearningSync } = await import('../src/main/learning')
  stopLearningSync()
  const { stopDocumentWorkers } = await import('../src/main/documents')
  stopDocumentWorkers()
  for (const close of cleanup) await close()
  const { closeDb } = await import('../src/main/db')
  closeDb()
  rmSync(root, { force: true, recursive: true })
})
beforeAll(async () => {
  const { setServerFetch } = await import('../src/main/serverclient')
  setServerFetch((url, init) => fetch(url, init))
})

it('publishes, browses, adds, syncs reading progress, updates and manages a document', async () => {
  const { testServer, signUp, auth } = await import('../../server/tests/helpers')
  const { createUser } = await import('../src/main/users')
  const { signIn } = await import('../src/main/servers')
  const { syncAll, stopLearningSync } = await import('../src/main/learning')
  const { importDocument, getDocument, listDocuments, setDocumentProgress } = await import('../src/main/documents')
  const { savePublication } = await import('../src/main/document-publish')
  const catalog = await import('../src/main/document-catalog')

  const server = await testServer({ webDir: null })
  cleanup.push(server.close)
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
  const me = await signUp(server, 'reader')
  const other = await signUp(server, 'publisher')
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, payload?: object) =>
    server.app.inject({ method, url: `/api/v1${path}`, headers: auth(token), ...(payload ? { payload } : {}) })

  createUser('Reader')
  const connection = await signIn(base, me.email, 'correct horse battery')

  /* The app publishes a document from the library. */
  const file = join(root, 'Local notes.pdf')
  writeFileSync(file, fixturePdf({ pages: 3 }))
  const imported = await importDocument(file)
  if (imported.status !== 'ok') throw new Error('not imported')
  const mine = imported.document.id
  savePublication(mine, { description: 'My *notes*', tags: ['Notes'], version: '1.0.0' })
  expect((await catalog.previewDocumentPublish(mine, connection.id)).problems).toEqual([])
  const published = await catalog.publishLocalDocument(mine, connection.id, 'First edition')
  expect(published).toMatchObject({ created: true, document: { id: mine, version: '1.0.0', ownedByYou: true, publisher: 'reader' } })
  expect(published.document.versions[0]!.releaseNote).toBe('First edition')
  // A version can only go up, and the preview says so before anything is sent.
  expect((await catalog.previewDocumentPublish(mine, connection.id)).problems.join(' ')).toContain('already taken')
  // The original is the library's copy of what it published.
  expect(catalog.libraryDocumentFor(connection.id, mine)).toBe(mine)
  expect(catalog.documentHomes(mine)).toEqual([connection.id])
  expect(listDocuments().find((d) => d.id === mine)?.publishedTo).toEqual([connection.id])

  /* Someone else's document, published straight to the server. */
  const theirs = randomUUID()
  const upload = (version: string) => {
    const zip = makeZip(join(root, `${randomUUID()}.zip`), [
      { name: 'document.json', content: JSON.stringify({ title: 'Field guide', description: 'Birds', tags: ['Nature'], version, releaseNote: `Edition ${version}` }) },
      { name: 'document.pdf', bytes: fixturePdf({ pages: 3 }) }
    ])
    return server.app.inject({ method: 'POST', url: `/api/v1/documents/${theirs}/versions`, headers: { ...auth(other.token), 'content-type': 'application/zip' }, payload: readFileSync(zip) })
  }
  expect((await upload('1.0.0')).statusCode).toBe(201)

  /* Browsing: search, tags, sort and the overview. */
  const page = await catalog.searchDocuments(connection.id, { q: 'field' })
  expect(page.documents.map((d) => d.id)).toEqual([theirs])
  expect(page.documents[0]).toMatchObject({ downloads: 0, publisher: 'publisher', pages: 3, listed: true, ownedByYou: false })
  expect((await catalog.searchDocuments(connection.id, { tags: ['Notes'] })).documents.map((d) => d.id)).toEqual([mine])
  expect((await catalog.searchDocuments(connection.id, { sort: 'title' })).documents.map((d) => d.title)).toEqual(['Field guide', 'Local notes'])
  expect((await catalog.documentTags(connection.id)).map((t) => t.tag).sort()).toEqual(['Nature', 'Notes'])
  expect(catalog.libraryDocumentFor(connection.id, theirs)).toBeNull()

  /* Adding it is an enrollment: the PDF arrives, and adding twice is refused. */
  const added = await catalog.addDocument(connection.id, theirs)
  expect(added).toMatchObject({ title: 'Field guide', version: '1.0.0' })
  const copy = added.documentId
  expect(catalog.libraryDocumentFor(connection.id, theirs)).toBe(copy)
  expect(listDocuments().find((d) => d.id === copy)?.origin).toMatchObject({ connectionId: connection.id, version: '1.0.0', remoteId: theirs })
  await expect(catalog.addDocument(connection.id, theirs)).rejects.toMatchObject({ code: 'exists' })
  expect((await catalog.catalogDocument(connection.id, theirs)).downloads).toBe(1)
  // A copy is not the reader's to publish.
  expect((await catalog.previewDocumentPublish(copy, connection.id)).problems.join(' ')).toContain('copy from a server')

  /* Reading here reaches the server, and reading there reaches here. */
  setDocumentProgress(copy, 2)
  await syncAll(true)
  const held = () => inject('GET', '/me/learning', me.token).then((r) => (r.json().items as LearningState[]).find((i) => i.enrollment.id === theirs)!)
  expect((await held()).fields.readPage?.value).toBe(2)
  const state = await held()
  const web = { kind: 'document', id: theirs, version: '1.0.0', generation: state.enrollment.generation, epoch: state.epoch, idempotencyKey: randomUUID(), at: Date.now() + 1000, field: 'readPage', value: 3 }
  expect((await inject('POST', '/sync', me.token, { operations: [web] })).statusCode).toBe(200)
  await syncAll(true)
  expect(getDocument(copy).readPage).toBe(3)

  /* Updates: the course rule, and the same PDF keeps its progress. */
  expect((await catalog.documentUpdates())[copy]).toEqual({ kind: 'current' })
  expect((await upload('1.1.0')).statusCode).toBe(201)
  expect((await catalog.documentUpdates())[copy]).toEqual({ kind: 'update', version: '1.1.0' })
  expect(await catalog.applyDocumentUpdate(copy)).toEqual({ version: '1.1.0' })
  expect(listDocuments().find((d) => d.id === copy)?.origin?.version).toBe('1.1.0')
  expect(getDocument(copy).readPage).toBe(3)
  expect((await held()).enrollment.version).toBe('1.1.0')
  expect((await inject('DELETE', `/documents/${theirs}`, other.token)).statusCode).toBe(200)
  expect((await catalog.documentUpdates())[copy]).toEqual({ kind: 'unlisted' })

  /* Managing what was published: rollback, unpublish, list again - and only the owner may. */
  savePublication(mine, { description: 'My notes', tags: ['Notes'], version: '1.1.0' })
  await catalog.publishLocalDocument(mine, connection.id)
  expect((await catalog.myDocuments(connection.id)).map((d) => d.id)).toEqual([mine])
  let managed = await catalog.setCurrentDocumentVersion(connection.id, mine, '1.0.0')
  expect(managed).toMatchObject({ version: '1.0.0', maxVersion: '1.1.0' })
  managed = await catalog.deleteDocumentVersion(connection.id, mine, '1.1.0')
  expect(managed.versions.find((v) => v.version === '1.1.0')?.deleted).toBe(true)
  expect((await catalog.unpublishDocument(connection.id, mine)).listed).toBe(false)
  expect((await catalog.searchDocuments(connection.id, {})).documents).toEqual([])
  expect((await catalog.relistDocument(connection.id, mine)).listed).toBe(true)
  await expect(catalog.publishedDocument(connection.id, theirs)).rejects.toMatchObject({ status: 404 })

  /* Leaving My learning keeps the download and the progress. */
  await catalog.leaveDocument(copy)
  expect(server.ctx.db.prepare("SELECT active FROM enrollments WHERE account_id=? AND kind='document' AND content_id=?").get(me.id, theirs)).toEqual({ active: 0 })
  expect(getDocument(copy).readPage).toBe(3)
  stopLearningSync()
}, 60000)
