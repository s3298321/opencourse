/**
 * Server documents, the way catalog.ts, server-courses.ts and publish.ts are
 * server courses: browsing a server's documents, adding one to the library,
 * checking for and installing updates, and everything a publisher can do to
 * what they published.
 *
 * Adding is an enrollment (learning.ts), so a document's reading progress is
 * the account's and follows it between this app and the server's web app.
 * Every answer is parsed by core/catalog/parse.ts before anything reads it,
 * and every refusal reaches the renderer as a ServerResult.
 */
import type { CatalogSort, CatalogTag } from '../core/catalog/api'
import { parseDocumentList, parseDocumentPage, parsePublishedDocument, parseTags } from '../core/catalog/parse'
import { UID } from '../core/catalog/identity'
import { compareVersions, isVersion } from '../core/catalog/semver'
import { updateState, type UpdateState } from '../core/catalog/origin'
import type { PublishedDocument } from '../core/learning/types'
import { db } from './db'
import { callServer, ServerError } from './serverclient'
import { listConnections, serverAccess } from './servers'
import { anyBinding, bindingFor, type Binding } from './learning-store'
import { enrollFromDesktop } from './learning'
import { getDocument } from './documents'
import { publication, publishDocument, savePublication } from './document-publish'

export interface DocumentQuery { q?: string; tags?: string[]; sort?: CatalogSort; page?: number }
export interface DocumentPage { documents: PublishedDocument[]; total: number; page: number; pageSize: number }
/** What publishing a local document to a server would do, before it does it. */
export interface DocumentPublishPreview {
  serverName: string
  title: string
  version: string
  /** Null for a document this server has never had. */
  maxVersion: string | null
  problems: string[]
}

const SORTS: ReadonlySet<string> = new Set(['downloads', 'recent', 'title'])

/** A plain Error from the enrollment or install path becomes an answer, not "Error invoking remote method". */
async function answered<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ServerError) throw error
    throw new ServerError(409, 'refused', (error as Error).message)
  }
}

function requireDocumentUid(id: string): string {
  if (typeof id !== 'string' || !UID.test(id)) throw new ServerError(400, 'invalid_document', 'That is not a document on this server.')
  return id
}

function requireDocuments(serverId: string) {
  const access = serverAccess(serverId)
  if (access.capabilities && !access.capabilities.includes('documents-v1')) throw new ServerError(404, 'no_documents', `${access.name} does not offer documents.`)
  return access
}

function signedIn(serverId: string) {
  const access = requireDocuments(serverId)
  if (!access.account || !access.token) throw new ServerError(401, 'signed_out', `Sign in to ${access.name} first, in Settings → Servers.`)
  return access
}

export async function searchDocuments(serverId: string, query: DocumentQuery = {}): Promise<DocumentPage> {
  const access = requireDocuments(serverId)
  const params = new URLSearchParams()
  if (typeof query.q === 'string' && query.q.trim()) params.set('q', query.q.trim().slice(0, 200))
  for (const tag of (Array.isArray(query.tags) ? query.tags : []).slice(0, 5)) if (typeof tag === 'string' && tag) params.append('tag', tag.slice(0, 60))
  if (typeof query.sort === 'string' && SORTS.has(query.sort)) params.set('sort', query.sort)
  if (Number.isInteger(query.page) && query.page! > 1) params.set('page', String(Math.min(query.page!, 1000)))
  const search = params.toString()
  return callServer(access.url, `/documents${search ? `?${search}` : ''}`, parseDocumentPage, { token: access.token || null, route: '/documents' })
}

export async function documentTags(serverId: string): Promise<CatalogTag[]> {
  const access = requireDocuments(serverId)
  try {
    return await callServer(access.url, '/documents/tags', parseTags, { route: '/documents/tags' })
  } catch (error) {
    // A server from before document tags simply has none to offer.
    if (error instanceof ServerError && error.status === 404) return []
    throw error
  }
}

export async function catalogDocument(serverId: string, id: string): Promise<PublishedDocument> {
  const access = requireDocuments(serverId)
  return callServer(access.url, `/documents/${requireDocumentUid(id)}`, parsePublishedDocument, { token: access.token || null, route: '/documents/:id' })
}

/**
 * The library document that is this server document, if there is one: a copy
 * this account added, or the local original its publisher published from.
 * A copy whose download was removed is not in the library any more.
 */
export function libraryDocumentFor(serverId: string, id: string): string | null {
  if (!UID.test(String(id))) return null
  const access = serverAccess(serverId)
  if (access.serverId && access.account) {
    const row = db().prepare("SELECT local_id FROM learning_bindings WHERE server_id=? AND account_id=? AND kind='document' AND remote_id=? AND downloaded<>-1")
      .get(access.serverId, access.account.id, id) as { local_id: string } | undefined
    if (row) return row.local_id
  }
  const published = db().prepare('SELECT id FROM documents WHERE id=? AND publication IS NOT NULL').get(id) as { id: string } | undefined
  return published && publication(published.id).publications[serverId] === id ? published.id : null
}

/** Every server document's library copy, for the catalog's "In your library". */
export function libraryDocuments(serverId: string, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of Array.isArray(ids) ? ids.slice(0, 200) : []) {
    const local = libraryDocumentFor(serverId, id)
    if (local) out[id] = local
  }
  return out
}

export async function addDocument(serverId: string, id: string): Promise<{ documentId: string; title: string; version: string }> {
  const access = signedIn(serverId)
  requireDocumentUid(id)
  if (access.capabilities && !access.capabilities.includes('learning-sync-v1')) throw new ServerError(404, 'no_sync', `${access.name} cannot keep reading progress, so its documents cannot be added.`)
  const existing = libraryDocumentFor(serverId, id)
  if (existing) throw new ServerError(409, 'exists', 'This document is already in your library.')
  const result = await answered(() => enrollFromDesktop(serverId, 'document', id))
  return { documentId: result.courseId, title: result.title, version: result.version }
}

function documentBindings(): Binding[] {
  return db().prepare("SELECT * FROM learning_bindings WHERE kind='document' AND downloaded<>-1").all() as unknown as Binding[]
}

/** What the Documents page offers for each server copy: the course rule, against the document's own record. */
export async function documentUpdates(): Promise<Record<string, UpdateState>> {
  const out: Record<string, UpdateState> = {}
  const connected = new Set(listConnections().filter((c) => c.account).map((c) => c.id))
  await Promise.all(documentBindings().map(async (b) => {
    if (!connected.has(b.connection_id) || !bindingFor(b.local_id)) { out[b.local_id] = { kind: 'disconnected', reason: 'not-connected' }; return }
    try {
      const access = serverAccess(b.connection_id)
      const remote = await callServer(access.url, `/documents/${b.remote_id}`, parsePublishedDocument, { token: access.token || null, route: '/documents/:id' })
      out[b.local_id] = updateState(b.version, { id: remote.id, currentVersion: remote.version, listed: remote.listed })
    } catch (error) {
      out[b.local_id] = error instanceof ServerError && error.status === 404 ? { kind: 'unlisted' } : { kind: 'disconnected', reason: 'unreachable' }
    }
  }))
  return out
}

/**
 * Installs the server's current version. Accepting a version is an
 * enrollment change, so every device of this account follows it; reading
 * progress carries over unless the PDF itself changed.
 */
export async function applyDocumentUpdate(localId: string): Promise<{ version: string }> {
  const b = anyBinding(localId)
  if (!b) throw new ServerError(400, 'not_server', 'This document did not come from a server.')
  if (!bindingFor(localId)) throw new ServerError(401, 'signed_out', 'Sign in to the account this document was added with first.')
  const remote = await catalogDocument(b.connection_id, b.remote_id)
  if (!remote.listed) throw new ServerError(409, 'unlisted', 'This document is no longer published.')
  const result = await answered(() => enrollFromDesktop(b.connection_id, 'document', b.remote_id, remote.version))
  return { version: result.version }
}

/** Removes a server document from My learning on every device; the download, progress and chats stay. */
export async function leaveDocument(localId: string): Promise<void> {
  const b = anyBinding(localId)
  if (!b) throw new ServerError(400, 'not_server', 'This document did not come from a server.')
  if (!bindingFor(localId)) throw new ServerError(401, 'signed_out', 'Sign in to the account this document was added with first.')
  const access = serverAccess(b.connection_id)
  await callServer(access.url, `/me/learning/document/${b.remote_id}`, () => ({}), { method: 'DELETE', token: access.token, route: '/me/learning/:kind/:id' })
}

/* --- publishing ---------------------------------------------------------- */

/** Where a local document is published: the connections that have it. */
export function documentHomes(localId: string): string[] {
  return Object.keys(publication(localId).publications).filter((id) => listConnections().some((c) => c.id === id))
}

export async function previewDocumentPublish(localId: string, serverId: string): Promise<DocumentPublishPreview> {
  const access = signedIn(serverId)
  const document = getDocument(localId), meta = publication(localId)
  const problems: string[] = []
  if (anyBinding(localId)) problems.push('This is a copy from a server. Only a document imported here can be published.')
  if (!document.title.trim()) problems.push('Give the document a title.')
  if (!isVersion(meta.version)) problems.push('Give it a version like 1.0.0.')
  let maxVersion: string | null = null
  try {
    const remote = await catalogDocument(serverId, localId)
    if (!remote.ownedByYou) problems.push(`Another account on ${access.name} already published a document with this identity.`)
    maxVersion = remote.maxVersion
  } catch (error) {
    if (!(error instanceof ServerError && error.status === 404)) throw error
  }
  if (maxVersion && isVersion(meta.version) && compareVersions(meta.version, maxVersion) <= 0)
    problems.push(`v${meta.version} is already taken: the next version must be higher than v${maxVersion}. Raise it under Overview.`)
  return { serverName: access.name, title: document.title, version: meta.version, maxVersion, problems }
}

export async function publishLocalDocument(localId: string, serverId: string, note?: string): Promise<{ document: PublishedDocument; created: boolean }> {
  signedIn(serverId)
  // The panel's "what changed" is this version's release note, kept with the overview.
  if (typeof note === 'string') { const meta = publication(localId); savePublication(localId, { description: meta.description, tags: meta.tags, version: meta.version, releaseNote: note.slice(0, 4000) }) }
  const before = Object.keys(publication(localId).publications).includes(serverId)
  const document = await answered(() => publishDocument(localId, serverId))
  return { document, created: !before }
}

async function owned(serverId: string, id: string): Promise<PublishedDocument> {
  const value = await catalogDocument(serverId, id)
  if (!value.ownedByYou) throw new ServerError(404, 'not_found', 'Only its publisher can manage this document.')
  return value
}

/** A publisher's own documents on one server, listed or not. */
export async function myDocuments(serverId: string): Promise<PublishedDocument[]> {
  const access = signedIn(serverId)
  return callServer(access.url, '/me/documents', parseDocumentList, { token: access.token, route: '/me/documents' })
}

export async function publishedDocument(serverId: string, id: string): Promise<PublishedDocument> {
  signedIn(serverId)
  return owned(serverId, requireDocumentUid(id))
}

async function manage(serverId: string, id: string, path: string, method: 'POST' | 'PUT' | 'DELETE', route: string, json?: unknown): Promise<PublishedDocument> {
  const access = signedIn(serverId)
  requireDocumentUid(id)
  await callServer(access.url, path, () => ({}), { method, token: access.token, route, ...(json === undefined ? {} : { json }) })
  return owned(serverId, id)
}

export function setCurrentDocumentVersion(serverId: string, id: string, version: string): Promise<PublishedDocument> {
  if (!isVersion(version)) throw new ServerError(400, 'invalid_version', 'That is not a version.')
  return manage(serverId, id, `/documents/${id}/current`, 'PUT', '/documents/:id/current', { version })
}

export function deleteDocumentVersion(serverId: string, id: string, version: string): Promise<PublishedDocument> {
  if (!isVersion(version)) throw new ServerError(400, 'invalid_version', 'That is not a version.')
  return manage(serverId, id, `/documents/${id}/versions/${version}`, 'DELETE', '/documents/:id/versions/:version')
}

export function reindexDocumentVersion(serverId: string, id: string, version: string): Promise<PublishedDocument> {
  if (!isVersion(version)) throw new ServerError(400, 'invalid_version', 'That is not a version.')
  return manage(serverId, id, `/documents/${id}/versions/${version}/reindex`, 'POST', '/documents/:id/versions/:version/reindex', {})
}

export function unpublishDocument(serverId: string, id: string): Promise<PublishedDocument> {
  return manage(serverId, id, `/documents/${id}`, 'DELETE', '/documents/:id')
}

export function relistDocument(serverId: string, id: string): Promise<PublishedDocument> {
  return manage(serverId, id, `/documents/${id}/relist`, 'POST', '/documents/:id/relist', {})
}
