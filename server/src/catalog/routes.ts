import { createReadStream, existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { CatalogSort } from '@core/catalog/api'
import type { Ctx } from '../context'
import { badRequest, notFound } from '../errors'
import { requireAccount } from '../auth/routes'
import { catalogPage, courseOverview, courseStatuses, recordAcquisition, tagCounts, visibleCourse } from './catalog'
import { SERVER_VERSION } from '../version'

const SORTS: ReadonlySet<string> = new Set(['downloads', 'recent', 'title'])

export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' && value ? [value] : []
}

/** The catalog's query string, as the API and the web app's first paint both read it. */
export function catalogQuery(query: Record<string, unknown>): { q?: string; tags: string[]; sort?: CatalogSort; page: number } {
  const sort = typeof query['sort'] === 'string' && SORTS.has(query['sort']) ? query['sort'] as CatalogSort : undefined
  return { q: typeof query['q'] === 'string' ? query['q'].slice(0, 200) : undefined, tags: asList(query['tag']).slice(0, 5), sort, page: Number(query['page'] ?? 1) || 1 }
}

export function registerCatalogRoutes(app: FastifyInstance, ctx: Ctx): void {
  const d = ctx.db

  app.get('/api/v1/server', async () => ({ opencourse: 1, api: 1, name: ctx.config.name, description: ctx.config.description, registration: ctx.config.registration, version: SERVER_VERSION }))

  // For a load balancer or a container's health check: the database answers.
  app.get('/healthz', async (_request, reply) => {
    d.prepare('SELECT 1').get()
    return reply.header('Cache-Control', 'no-store').send({ ok: true })
  })

  app.get('/api/v1/courses', async (request) => catalogPage(d, catalogQuery(request.query as Record<string, unknown>)))

  app.get('/api/v1/tags', async () => ({ tags: tagCounts(d) }))

  app.get('/api/v1/courses/:id', async (request) => {
    const overview = courseOverview(d, (request.params as { id: string }).id, request.account)
    if (!overview) throw notFound('That course is not on this server.')
    return overview
  })

  app.get('/api/v1/courses/:id/cover', async (request, reply) => {
    const row = visibleCourse(d, (request.params as { id: string }).id, request.account)
    const cover = row && d.prepare('SELECT cover_path, cover_type FROM course_versions WHERE course_id = ? AND version = ?').get(row.id, row.current_version) as { cover_path: string | null; cover_type: string | null } | undefined
    if (!cover?.cover_path || !cover.cover_type || !existsSync(cover.cover_path)) throw notFound()
    // A cover is an author's file. As an SVG opened on its own it could carry
    // script, so it is sandboxed: it renders, and runs nothing.
    return reply.type(cover.cover_type).header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'public, max-age=300').send(createReadStream(cover.cover_path))
  })

  app.post('/api/v1/courses/status', {
    schema: { body: { type: 'object', required: ['ids'], additionalProperties: false, properties: { ids: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 64 } } } } }
  }, async (request) => ({ courses: courseStatuses(d, (request.body as { ids: string[] }).ids, request.account) }))

  // Adding and updating are both a download of the current version; each one
  // is recorded, and the catalog's count is the distinct accounts that added.
  app.post('/api/v1/courses/:id/download', {
    schema: { body: { type: 'object', required: ['intent'], additionalProperties: false, properties: { intent: { enum: ['add', 'update'] } } } }
  }, async (request, reply) => {
    const account = requireAccount(request)
    const row = visibleCourse(d, (request.params as { id: string }).id, account)
    if (!row?.current_version) throw notFound('That course is not on this server.')
    const version = d.prepare('SELECT archive_path, bytes, sha256 FROM course_versions WHERE course_id = ? AND version = ? AND deleted_at IS NULL').get(row.id, row.current_version) as { archive_path: string | null; bytes: number; sha256: string } | undefined
    if (!version?.archive_path || !existsSync(version.archive_path)) throw badRequest('archive_missing', 'This version\'s archive is missing on the server.')
    recordAcquisition(d, row.id, account.id, row.current_version, (request.body as { intent: 'add' | 'update' }).intent)
    return reply.type('application/zip').header('Content-Length', String(version.bytes))
      .header('X-OpenCourse-Version', row.current_version).header('X-OpenCourse-Sha256', version.sha256)
      .send(createReadStream(version.archive_path))
  })
}
