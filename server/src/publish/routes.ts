import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Account } from '@core/catalog/api'
import { LIMITS } from '@core/import'
import type { Ctx } from '../context'
import { ApiError, notFound } from '../errors'
import { requireAccount } from '../auth/routes'
import { managedCourse, ownedCourses } from '../catalog/catalog'
import { deleteVersion, MAX_RELEASE_NOTE, publishVersion, relistCourse, setCurrentVersion, unpublishCourse } from './publish'

const tooLarge = (): ApiError => new ApiError(413, 'too_large', `A course archive may be at most ${LIMITS.archiveBytes / 1024 / 1024} MB.`)

export function registerPublishRoutes(app: FastifyInstance, ctx: Ctx): void {
  const d = ctx.db
  // The archive arrives as the raw body; it is streamed to disk and counted,
  // so a lying Content-Length cannot make it bigger than the cap.
  app.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload))

  app.post('/api/v1/courses/:id/versions', async (request, reply) => {
    const account = requireAccount(request)
    const declared = Number(request.headers['content-length'] ?? 0)
    if (declared > LIMITS.archiveBytes) throw tooLarge()
    if (request.headers['content-type'] !== 'application/zip') throw new ApiError(415, 'unsupported_type', 'Send the course as application/zip.')
    let note = ''
    try { note = decodeURIComponent(String(request.headers['x-opencourse-release-note'] ?? '')) } catch { /* left empty */ }
    note = note.slice(0, MAX_RELEASE_NOTE + 1)
    mkdirSync(join(ctx.config.dataDir, 'tmp'), { recursive: true })
    const upload = join(ctx.config.dataDir, 'tmp', `upload-${randomUUID()}.zip`)
    try {
      let bytes = 0
      const counter = new Transform({ transform(chunk: Buffer, _enc, next) { bytes += chunk.length; next(bytes > LIMITS.archiveBytes ? tooLarge() : null, chunk) } })
      await pipeline(request.body as NodeJS.ReadableStream, counter, createWriteStream(upload))
      const result = await publishVersion(d, ctx.config.dataDir, account, (request.params as { id: string }).id, upload, note)
      request.log.info({ courseId: result.courseId, version: result.version, created: result.created }, 'course published')
      return reply.code(result.created ? 201 : 200).send(result)
    } finally {
      rmSync(upload, { force: true })
    }
  })

  app.get('/api/v1/me/courses', async (request) => ({ courses: ownedCourses(d, requireAccount(request)) }))

  app.get('/api/v1/courses/:id/versions', async (request) => {
    const course = managedCourse(d, (request.params as { id: string }).id, requireAccount(request))
    if (!course) throw notFound('That course is not one of yours.')
    return course
  })

  /** Runs an owner-only change, then answers with the course as its owner now sees it. */
  const manage = (change: (account: Account, id: string, params: Record<string, string>) => void) => async (request: FastifyRequest) => {
    const account = requireAccount(request), params = request.params as Record<string, string>
    change(account, params['id']!, params)
    return managedCourse(d, params['id']!, account)
  }

  app.put('/api/v1/courses/:id/current', {
    schema: { body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version: { type: 'string', maxLength: 40 } } } }
  }, async (request) => {
    const account = requireAccount(request), id = (request.params as { id: string }).id
    setCurrentVersion(d, account, id, (request.body as { version: string }).version)
    return managedCourse(d, id, account)
  })
  app.delete('/api/v1/courses/:id/versions/:version', manage((account, id, params) => deleteVersion(d, account, id, params['version']!)))
  app.delete('/api/v1/courses/:id', manage((account, id) => unpublishCourse(d, account, id)))
  app.post('/api/v1/courses/:id/relist', manage((account, id) => relistCourse(d, account, id)))
}
