import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { extractArchive } from '@app/unzip'
import { isVersion, compareVersions } from '@core/catalog/semver'
import type { PublishedDocument } from '@core/learning/types'
import type { Ctx } from '../context'
import { requireAccount, requireAdmin } from '../auth/routes'
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany } from '../errors'
import { RateLimiter } from '../ratelimit'
import { audit } from '../audit'
import { tx } from '../db'
import { DOCUMENT_POLICY } from '@core/documents/publication'

let workers = 0
function indexPdf(
  path: string,
  metadataOnly = false
): Promise<{ pages: number; sections: PublishedDocument['sections']; texts: string[] }> {
  if (workers >= 2) return Promise.reject(tooMany('Document processing is busy. Retry shortly.'))
  workers++
  return new Promise<{ pages: number; sections: PublishedDocument['sections']; texts: string[] }>((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
      workerData: { path, metadataOnly },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(badRequest('invalid_pdf', 'PDF indexing exceeded its time limit.'))
    }, 60000)
    worker.once('message', (result) => {
      clearTimeout(timer)
      void worker.terminate()
      result.error ? reject(badRequest('invalid_pdf', result.error)) : resolve(result)
    })
    worker.once('error', () => {
      clearTimeout(timer)
      reject(badRequest('invalid_pdf', 'PDF indexing failed.'))
    })
    worker.once('exit', () => {
      clearTimeout(timer)
      // Reject an exit without a result, even exit(0). Settled promises ignore this.
      reject(badRequest('invalid_pdf', 'PDF indexing stopped.'))
    })
  }).finally(() => {
    workers--
  })
}
export function documentOverview(ctx: Ctx, id: string, account?: string, version?: string): PublishedDocument {
  const d = ctx.db
  const row = d
    .prepare(
      `SELECT p.*,a.username,v.* FROM published_documents p JOIN accounts a ON a.id=p.owner_id
    JOIN document_versions v ON v.document_id=p.id AND v.version=COALESCE(?,p.current_version) WHERE p.id=? AND v.deleted_at IS NULL`
    )
    .get(version ?? null, id) as Record<string, unknown> | undefined
  const enrolled =
    account &&
    d
      .prepare("SELECT 1 FROM enrollments WHERE account_id=? AND kind='document' AND content_id=? AND active=1")
      .get(account, id)
  if (!row || (row.owner_id !== account && (row.moderated_at || (row.unlisted_at && !enrolled)))) throw notFound()
  return {
    id,
    title: String(row.title),
    description: String(row.description),
    tags: JSON.parse(String(row.tags)),
    version: String(row.version),
    publisher: String(row.username),
    hasCover: Boolean(row.cover_path),
    bytes: Number(row.bytes),
    pages: Number(row.pages),
    fingerprint: String(row.fingerprint),
    status: row.status as PublishedDocument['status'],
    error: row.error as string | null,
    sections: JSON.parse(String(row.sections)),
    listed: !row.unlisted_at && !row.moderated_at,
    ownedByYou: row.owner_id === account,
    // Accounts that ever added it, like a course's downloads: analytics, not enrollment.
    downloads: Number(
      (
        d
          .prepare("SELECT COUNT(*) AS n FROM enrollments WHERE kind='document' AND content_id=?")
          .get(id) as { n: number }
      ).n
    ),
    updatedAt: String(row.published_at),
    maxVersion: String(row.max_version),
    // Only its owner learns that a moderator removed it; to everyone else it is gone.
    ...(row.owner_id === account && row.moderated_at ? { moderated: true } : {}),
    versions: (
      d
        .prepare(
          'SELECT version,published_at,release_note,deleted_at FROM document_versions WHERE document_id=? ORDER BY published_at DESC'
        )
        .all(id) as Record<string, unknown>[]
    ).map((v) => ({
      version: String(v.version),
      publishedAt: String(v.published_at),
      releaseNote: String(v.release_note),
      deleted: Boolean(v.deleted_at)
    }))
  }
}
export function registerDocumentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const d = ctx.db
  const uploads = new RateLimiter(10, 60000)
  let indexing = false,
    closing = false
  let work: Promise<void> = Promise.resolve()
  const resumeIndex = () => {
    if (indexing || closing) return
    indexing = true
    work = (async () => {
      try {
        while (!closing) {
          if (workers >= 2) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            continue
          }
          const row = d
            .prepare(
              "SELECT document_id,version,pdf_path FROM document_versions WHERE status='indexing' AND deleted_at IS NULL LIMIT 1"
            )
            .get() as { document_id: string; version: string; pdf_path: string } | undefined
          if (!row) break
          try {
            const result = await indexPdf(row.pdf_path)
            if (closing) break
            tx(d, () => {
              if (
                !d
                  .prepare('SELECT 1 FROM document_versions WHERE document_id=? AND version=? AND deleted_at IS NULL')
                  .get(row.document_id, row.version)
              )
                return
              d.prepare('DELETE FROM document_text WHERE document_id=? AND version=?').run(row.document_id, row.version)
              for (const [i, text] of result.texts.entries())
                d.prepare('INSERT INTO document_text VALUES(?,?,?,?)').run(row.document_id, row.version, i + 1, text)
              d.prepare("UPDATE document_versions SET status='ready',error=NULL WHERE document_id=? AND version=?").run(
                row.document_id,
                row.version
              )
            })
          } catch {
            if (!closing) {
              d.prepare(
                "UPDATE document_versions SET status='error',error='Text indexing failed. The publisher can retry.' WHERE document_id=? AND version=?"
              ).run(row.document_id, row.version)
              app.log.warn({ document: row.document_id, version: row.version }, 'document.index.failed')
            }
          }
        }
      } finally {
        indexing = false
      }
    })()
  }
  app.addHook('onReady', async () => {
    resumeIndex()
  })
  app.addHook('onClose', async () => {
    closing = true
    await work
  })
  const listed = () =>
    (
      d
        .prepare(
          'SELECT id FROM published_documents WHERE unlisted_at IS NULL AND moderated_at IS NULL ORDER BY created_at DESC'
        )
        .all() as { id: string }[]
    ).map((r) => r.id)
  app.get('/api/v1/documents', async (req) => {
    const query = req.query as { q?: string; page?: string; sort?: string; tag?: string | string[] }
    const q = String(query.q ?? '')
      .slice(0, 200)
      .toLowerCase()
    const tags = (Array.isArray(query.tag) ? query.tag : query.tag ? [query.tag] : [])
      .slice(0, 5)
      .map((t) => String(t).slice(0, 60).toLowerCase())
    const items = listed()
      .map((id) => documentOverview(ctx, id, req.account?.id))
      .filter((v) => `${v.title} ${v.description} ${v.tags.join(' ')}`.toLowerCase().includes(q))
      .filter((v) => tags.every((tag) => v.tags.some((t) => t.toLowerCase() === tag)))
    // Without a sort, newest first: the order the catalog has always had.
    if (query.sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title))
    if (query.sort === 'downloads') items.sort((a, b) => b.downloads - a.downloads)
    if (query.sort === 'recent') items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const page = Math.max(1, Number(query.page) || 1)
    return { documents: items.slice((page - 1) * 30, page * 30), total: items.length, page, pageSize: 30 }
  })
  // Registered before `/documents/:id`, and a static segment wins in Fastify's router anyway.
  app.get('/api/v1/documents/tags', async () => {
    const counts = new Map<string, number>()
    for (const id of listed())
      for (const tag of documentOverview(ctx, id).tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return {
      tags: [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 200)
    }
  })
  app.get('/api/v1/documents/:id', async (req) =>
    documentOverview(ctx, (req.params as { id: string }).id, req.account?.id)
  )
  app.get('/api/v1/me/documents', async (req) => ({
    documents: (
      d
        .prepare(
          'SELECT id FROM published_documents WHERE owner_id=? AND EXISTS(SELECT 1 FROM document_versions v WHERE v.document_id=published_documents.id AND v.deleted_at IS NULL)'
        )
        .all(requireAccount(req).id) as { id: string }[]
    ).map((r) => documentOverview(ctx, r.id, req.account!.id))
  }))
  app.get('/api/v1/documents/:id/cover', async (req, reply) => {
    const item = documentOverview(ctx, (req.params as { id: string }).id, req.account?.id)
    const row = d
      .prepare('SELECT cover_path,cover_type FROM document_versions WHERE document_id=? AND version=?')
      .get(item.id, item.version) as { cover_path: string | null; cover_type: string | null }
    if (!row.cover_path || !existsSync(row.cover_path)) throw notFound()
    return reply
      .type(row.cover_type!)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(createReadStream(row.cover_path))
  })
  app.post('/api/v1/documents/:id/versions', async (req, reply) => {
    const account = requireAccount(req),
      id = (req.params as { id: string }).id
    if (!uploads.hit(account.id)) throw tooMany('Please wait before publishing another document.')
    if (req.via === 'web') throw forbidden('desktop_only', 'Publish documents from the desktop app.')
    if (!/^[a-f0-9-]{36}$/.test(id)) throw badRequest('invalid_id', 'Invalid document ID.')
    const owner = d.prepare('SELECT owner_id,max_version FROM published_documents WHERE id=?').get(id) as
      { owner_id: string; max_version: string } | undefined
    if (owner && owner.owner_id !== account.id) throw notFound()
    const maximum = ctx.config.documentMaxBytes ?? DOCUMENT_POLICY.limits.archiveBytes
    if (req.headers['content-type'] !== 'application/zip')
      throw badRequest('invalid_package', 'Send a document ZIP package.')
    const work = join(ctx.config.dataDir, 'tmp', randomUUID()),
      zip = join(work, 'upload.zip'),
      staging = join(work, 'package')
    mkdirSync(work, { recursive: true })
    try {
      let bytes = 0
      await pipeline(
        req.body as NodeJS.ReadableStream,
        new Transform({
          transform(chunk: Buffer, _e, next) {
            bytes += chunk.length
            next(
              bytes > maximum
                ? new ApiError(413, 'too_large', 'Document package exceeds the server upload limit.')
                : null,
              chunk
            )
          }
        }),
        createWriteStream(zip)
      )
      const extracted = await extractArchive(zip, staging, DOCUMENT_POLICY)
      if (extracted.error) throw badRequest('invalid_package', extracted.error)
      let metadata: {
        title: string
        description: string
        tags: string[]
        version: string
        releaseNote?: string
        cover?: string
      }
      try {
        metadata = JSON.parse(readFileSync(join(staging, 'document.json'), 'utf8'))
      } catch {
        throw badRequest('invalid_package', 'Missing document.json.')
      }
      if (
        typeof metadata.title !== 'string' ||
        !metadata.title.trim() ||
        metadata.title.length > 300 ||
        typeof metadata.description !== 'string' ||
        metadata.description.length > 20000 ||
        !Array.isArray(metadata.tags) ||
        metadata.tags.length > 30 ||
        metadata.tags.some((t) => typeof t !== 'string' || t.length > 60) ||
        !isVersion(metadata.version)
      )
        throw badRequest('invalid_metadata', 'Invalid document metadata.')
      if (owner && compareVersions(metadata.version, owner.max_version) <= 0)
        throw conflict('version_taken', 'Choose a version higher than every previously published version.')
      const allowed = new Set(['document.json', 'document.pdf', metadata.cover].filter(Boolean))
      if (readdirSync(staging).some((name) => !allowed.has(name)))
        throw badRequest('invalid_package', 'The package may contain only document.json, document.pdf and its cover.')
      const pdf = join(staging, 'document.pdf')
      if (!existsSync(pdf) || !readFileSync(pdf).subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw badRequest('invalid_pdf', 'Missing or invalid document.pdf.')
      const indexed = await indexPdf(pdf, true),
        hash = createHash('sha256')
      for await (const chunk of createReadStream(pdf)) hash.update(chunk)
      const fingerprint = hash.digest('hex'),
        size = statSync(pdf).size
      let cover: string | null = null,
        type: string | null = null
      if (metadata.cover) {
        if (!/^cover\.(png|jpg|jpeg|webp)$/.test(metadata.cover))
          throw badRequest('invalid_cover', 'Use a PNG, JPEG or WebP cover named cover.ext.')
        cover = metadata.cover
        type = cover.endsWith('png') ? 'image/png' : cover.endsWith('webp') ? 'image/webp' : 'image/jpeg'
        if (!existsSync(join(staging, cover)) || statSync(join(staging, cover)).size > 5 * 1024 ** 2)
          throw badRequest('invalid_cover', 'Cover is missing or exceeds 5 MiB.')
      }
      if (cover) {
        const bytes = readFileSync(join(staging, cover))
        const valid =
          type === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : type === 'image/jpeg'
              ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
              : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        if (!valid) throw badRequest('invalid_cover', 'The preview image does not match its file type.')
      }
      const storageUsed = () =>
        (
          d.prepare('SELECT bytes,cover_path FROM document_versions WHERE deleted_at IS NULL').all() as {
            bytes: number
            cover_path: string | null
          }[]
        ).reduce(
          (sum, row) =>
            sum + row.bytes + (row.cover_path && existsSync(row.cover_path) ? statSync(row.cover_path).size : 0),
          0
        )
      const storedBytes = size + (cover ? statSync(join(staging, cover)).size : 0)
      if (storageUsed() + storedBytes > (ctx.config.documentStorageBytes ?? 10 * 1024 ** 3))
        throw new ApiError(413, 'storage_full', 'The server document storage limit has been reached.')
      const target = join(ctx.config.dataDir, 'documents', id, metadata.version)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target)) throw conflict('version_taken', 'This version already exists.')
      renameSync(staging, target)
      try {
        tx(d, () => {
          if (storageUsed() + storedBytes > (ctx.config.documentStorageBytes ?? 10 * 1024 ** 3))
            throw new ApiError(413, 'storage_full', 'The server document storage limit has been reached.')
          // Check again after asynchronous parsing: another publish may have committed.
          const latest = d
            .prepare('SELECT owner_id,max_version FROM published_documents WHERE id=?')
            .get(id) as typeof owner
          if (latest && (latest.owner_id !== account.id || compareVersions(metadata.version, latest.max_version) <= 0))
            throw conflict('version_taken', 'The publication changed. Choose a higher version.')
          d.prepare(
            `INSERT INTO published_documents(id,owner_id,current_version,max_version,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,max_version=excluded.max_version,unlisted_at=NULL`
          ).run(id, account.id, metadata.version, metadata.version, new Date().toISOString())
          d.prepare(
            `INSERT INTO document_versions(document_id,version,title,description,tags,pdf_path,cover_path,cover_type,bytes,fingerprint,pages,sections,status,published_at,release_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'indexing',?,?)`
          ).run(
            id,
            metadata.version,
            metadata.title,
            metadata.description,
            JSON.stringify(metadata.tags),
            join(target, 'document.pdf'),
            cover ? join(target, cover) : null,
            type,
            size,
            fingerprint,
            indexed.pages,
            JSON.stringify(indexed.sections),
            new Date().toISOString(),
            String(metadata.releaseNote ?? '').slice(0, 4000)
          )
          indexed.texts.forEach((text, i) =>
            d.prepare('INSERT INTO document_text VALUES(?,?,?,?)').run(id, metadata.version, i + 1, text)
          )
        })
      } catch (error) {
        rmSync(target, { recursive: true, force: true })
        throw error
      }
      audit(d, {
        actor: account,
        action: 'document.publish',
        targetKind: 'document',
        targetId: id,
        targetName: metadata.title,
        detail: metadata.version
      })
      resumeIndex()
      return reply.code(201).send(documentOverview(ctx, id, account.id))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
  const owned = (req: Parameters<typeof requireAccount>[0], id: string) => {
    const account = requireAccount(req)
    if (!d.prepare('SELECT 1 FROM published_documents WHERE id=? AND owner_id=?').get(id, account.id)) throw notFound()
    return account
  }
  app.delete('/api/v1/documents/:id', async (req) => {
    const { id } = req.params as { id: string }
    const a = owned(req, id)
    d.prepare('UPDATE published_documents SET unlisted_at=? WHERE id=?').run(new Date().toISOString(), id)
    return documentOverview(ctx, id, a.id)
  })
  app.put('/api/v1/documents/:id/current', async (req) => {
    const { id } = req.params as { id: string }
    const a = owned(req, id),
      version = (req.body as { version: string })?.version
    if (
      !d
        .prepare('SELECT 1 FROM document_versions WHERE document_id=? AND version=? AND deleted_at IS NULL')
        .get(id, version ?? '')
    )
      throw notFound()
    d.prepare('UPDATE published_documents SET current_version=? WHERE id=?').run(version, id)
    return documentOverview(ctx, id, a.id)
  })
  app.post('/api/v1/documents/:id/versions/:version/reindex', async (req) => {
    const { id, version } = req.params as { id: string; version: string }
    owned(req, id)
    d.prepare(
      "UPDATE document_versions SET status='indexing',error=NULL WHERE document_id=? AND version=? AND deleted_at IS NULL"
    ).run(id, version)
    resumeIndex()
    return { ok: true }
  })
  app.post('/api/v1/documents/:id/relist', async (req) => {
    const { id } = req.params as { id: string }
    const a = owned(req, id)
    documentOverview(ctx, id, a.id)
    d.prepare('UPDATE published_documents SET unlisted_at=NULL WHERE id=? AND current_version IS NOT NULL').run(id)
    return documentOverview(ctx, id, a.id)
  })
  app.delete('/api/v1/documents/:id/versions/:version', async (req) => {
    const { id, version } = req.params as { id: string; version: string }
    owned(req, id)
    const row = d
      .prepare('SELECT pdf_path,cover_path FROM document_versions WHERE document_id=? AND version=?')
      .get(id, version) as { pdf_path: string; cover_path: string } | undefined
    if (!row) throw notFound()
    d.prepare(
      'UPDATE document_versions SET deleted_at=?,pdf_path=NULL,cover_path=NULL WHERE document_id=? AND version=?'
    ).run(new Date().toISOString(), id, version)
    const replacement = (
      d
        .prepare(
          'SELECT version FROM document_versions WHERE document_id=? AND deleted_at IS NULL ORDER BY published_at DESC'
        )
        .all(id) as { version: string }[]
    ).sort((a, b) => compareVersions(b.version, a.version))[0]
    d.prepare(
      'UPDATE published_documents SET current_version=?,unlisted_at=CASE WHEN ? IS NULL THEN ? ELSE unlisted_at END WHERE id=? AND current_version=?'
    ).run(replacement?.version ?? version, replacement?.version ?? null, new Date().toISOString(), id, version)
    d.prepare('DELETE FROM document_text WHERE document_id=? AND version=?').run(id, version)
    if (row.pdf_path) rmSync(dirname(row.pdf_path), { recursive: true, force: true })
    return { ok: true }
  })
  app.post('/api/v1/admin/documents/:id/moderate', async (req) => {
    const actor = requireAdmin(req),
      id = (req.params as { id: string }).id
    d.prepare('UPDATE published_documents SET moderated_at=? WHERE id=?').run(new Date().toISOString(), id)
    audit(d, { actor, action: 'document.moderate', targetKind: 'document', targetId: id })
    return { ok: true }
  })
  app.post('/api/v1/admin/documents/:id/restore', async (req) => {
    const actor = requireAdmin(req),
      id = (req.params as { id: string }).id
    d.prepare('UPDATE published_documents SET moderated_at=NULL WHERE id=?').run(id)
    audit(d, { actor, action: 'document.restore', targetKind: 'document', targetId: id })
    return { ok: true }
  })
}
// Kept as a normal file for both tsx development and the bundled deployment.
export const pdfWorkerFile = fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url))
