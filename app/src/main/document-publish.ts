import { dialog } from 'electron'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { db } from './db'
import { documentFile, getDocument } from './documents'
import { userDocumentsDir } from './paths'
import { requireUser } from './users'
import { serverAccess } from './servers'
import { uploadArchive } from './serverclient'
import { parsePublishedDocument } from '../core/catalog/parse'
import { anyBinding } from './learning-store'
import type { PublishedDocument } from '../core/learning/types'
const execute = promisify(execFile)
export interface DocumentPublication {
  description: string
  tags: string[]
  version: string
  releaseNote?: string
  cover?: string
  publications: Record<string, string>
}
export function publication(id: string): DocumentPublication {
  getDocument(id)
  const row = db().prepare('SELECT publication FROM documents WHERE id=?').get(id) as { publication: string | null }
  return row.publication
    ? JSON.parse(row.publication)
    : { description: '', tags: [], version: '1.0.0', publications: {} }
}
export function savePublication(
  id: string,
  metadata: { description: string; tags: string[]; version: string; releaseNote?: string }
): DocumentPublication {
  if (anyBinding(id)) throw new Error('Publish a local document, not a downloaded learner copy.')
  if (
    (metadata.releaseNote !== undefined &&
      (typeof metadata.releaseNote !== 'string' || metadata.releaseNote.length > 4000)) ||
    typeof metadata.description !== 'string' ||
    metadata.description.length > 20000 ||
    !Array.isArray(metadata.tags) ||
    metadata.tags.length > 30 ||
    metadata.tags.some((t) => typeof t !== 'string' || t.length > 60) ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  )
    throw new Error('Invalid document publication metadata.')
  const value = {
    ...publication(id),
    description: metadata.description,
    tags: metadata.tags,
    version: metadata.version,
    releaseNote: metadata.releaseNote ?? ''
  }
  db().prepare('UPDATE documents SET publication=? WHERE id=?').run(JSON.stringify(value), id)
  return value
}
export async function chooseDocumentCover(id: string): Promise<DocumentPublication> {
  const owner = requireUser(),
    value = publication(id)
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Preview image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  })
  if (requireUser() !== owner) throw new Error('The local user changed.')
  if (result.canceled || !result.filePaths[0]) return value
  const path = result.filePaths[0],
    ext = extname(path).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || statSync(path).size > 5 * 1024 ** 2)
    throw new Error('Choose a PNG, JPEG or WebP image smaller than 5 MiB.')
  const cover = `${id}.cover${ext}`
  cpSync(path, join(userDocumentsDir(owner), cover))
  value.cover = cover
  db().prepare('UPDATE documents SET publication=? WHERE id=?').run(JSON.stringify(value), id)
  return value
}
export function documentCoverPreview(id: string): string | null {
  const cover = publication(id).cover
  if (!cover || !new RegExp(`^${id}\\.cover\\.(png|jpg|jpeg|webp)$`).test(cover)) return null
  const path = join(userDocumentsDir(requireUser()), cover)
  if (!existsSync(path)) return null
  const type = cover.endsWith('.png') ? 'image/png' : cover.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
  return `data:${type};base64,${readFileSync(path).toString('base64')}`
}
export async function publishDocument(id: string, connection: string): Promise<PublishedDocument> {
  if (anyBinding(id)) throw new Error('Publish a local document, not a downloaded learner copy.')
  const owner = requireUser(),
    doc = getDocument(id),
    value = publication(id),
    access = serverAccess(connection)
  if (!access.account) throw new Error('Sign in to this server first.')
  const work = mkdtempSync(join(tmpdir(), 'opencourse-document-publish-')),
    packageRoot = join(work, 'package'),
    zip = join(work, 'document.zip')
  try {
    mkdirSync(packageRoot)
    cpSync(documentFile(id), join(packageRoot, 'document.pdf'))
    const cover = value.cover ? `cover${extname(value.cover)}` : undefined
    if (value.cover) {
      if (!documentCoverPreview(id)) throw new Error('Choose a valid preview image.')
      cpSync(join(userDocumentsDir(owner), value.cover), join(packageRoot, cover!))
    }
    writeFileSync(
      join(packageRoot, 'document.json'),
      JSON.stringify({
        title: doc.title,
        description: value.description,
        tags: value.tags,
        version: value.version,
        releaseNote: value.releaseNote ?? '',
        ...(cover ? { cover } : {})
      })
    )
    await execute('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', packageRoot, zip])
    if (requireUser() !== owner) throw new Error('The local user changed.')
    const result = await uploadArchive(access.url, `/documents/${id}/versions`, zip, parsePublishedDocument, {
      token: access.token,
      route: '/documents/:id/versions'
    })
    if (requireUser() !== owner || serverAccess(connection).account?.id !== access.account.id)
      throw new Error('The connected account changed.')
    value.publications[connection] = result.id
    db().prepare('UPDATE documents SET publication=? WHERE id=?').run(JSON.stringify(value), id)
    return result
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
