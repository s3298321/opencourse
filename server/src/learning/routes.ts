import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ContentKind, ContentRef, LearningOperation } from '@core/learning/types'
import { grade } from '@core/grading'
import { scheduleCard, serializeCard, deserializeCard, type StoredCard } from '@core/review'
import type { ReviewRating } from '@core/types'
import type { Ctx } from '../context'
import { requireAccount } from '../auth/routes'
import { badRequest, notFound, forbidden } from '../errors'
import { contentRecord, courseAsset, coursePackage, learnerCourse, readCourse } from './content'
import { enroll, state, push, unenroll, validateOperation } from './sync'

export function reference(params: unknown): ContentRef {
  const ref = params as ContentRef
  if (
    !ref ||
    !['course', 'document'].includes(ref.kind) ||
    !/^[a-f0-9-]{36}$/.test(ref.id) ||
    typeof ref.version !== 'string' ||
    ref.version.length > 40
  )
    throw badRequest('invalid_content', 'Invalid content reference.')
  return { kind: ref.kind, id: ref.id, version: ref.version }
}
const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2'
}
export function registerLearningRoutes(app: FastifyInstance, ctx: Ctx): void {
  const d = ctx.db
  const coverOf = (ref: ContentRef) => {
    const row = d
      .prepare(
        ref.kind === 'course'
          ? 'SELECT cover_path,cover_type FROM course_versions WHERE course_id=? AND version=? AND deleted_at IS NULL'
          : 'SELECT cover_path,cover_type FROM document_versions WHERE document_id=? AND version=? AND deleted_at IS NULL'
      )
      .get(ref.id, ref.version) as { cover_path: string | null; cover_type: string | null } | undefined
    return row?.cover_path && row.cover_type && existsSync(row.cover_path)
      ? { cover_path: row.cover_path, cover_type: row.cover_type }
      : null
  }
  app.get('/api/v1/me/learning', async (req) => {
    const account = requireAccount(req).id
    return {
      items: (
        d
          .prepare('SELECT kind,content_id FROM enrollments WHERE account_id=? AND active=1 ORDER BY updated_at DESC')
          .all(account) as { kind: ContentKind; content_id: string }[]
      ).map((r) => {
        const item = state(ctx, account, r.kind, r.content_id)
        return { ...item, hasCover: Boolean(coverOf(item.enrollment)) }
      })
    }
  })
  app.put('/api/v1/me/learning/:kind/:id', async (req) => {
    const account = requireAccount(req).id,
      p = req.params as { kind: ContentKind; id: string },
      b = req.body as { version?: string }
    reference({ ...p, version: b?.version ?? '' })
    return enroll(ctx, account, p.kind, p.id, b?.version)
  })
  app.delete('/api/v1/me/learning/:kind/:id', async (req) => {
    const p = req.params as { kind: ContentKind; id: string }
    reference({ ...p, version: '' })
    unenroll(ctx, requireAccount(req).id, p.kind, p.id)
    return { ok: true }
  })
  app.get('/api/v1/sync', async (req) => {
    const account = requireAccount(req).id,
      cursor = Number((req.query as { cursor?: string }).cursor ?? 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw badRequest('invalid_cursor', 'Invalid sync cursor.')
    const rows = d
      .prepare(
        'SELECT cursor,type,key,value FROM learning_changes WHERE account_id=? AND cursor>? ORDER BY cursor LIMIT 101'
      )
      .all(account, cursor) as { cursor: number; type: string; key: string; value: string }[]
    let bytes = 0
    const page = rows.slice(0, 100).filter((r, i) => {
      bytes += r.value.length
      return i === 0 || bytes <= 3 * 1024 ** 2
    })
    return {
      changes: page.map((r) => ({ ...r, value: JSON.parse(r.value) })),
      cursor: page.at(-1)?.cursor ?? cursor,
      more: rows.length > page.length,
      serverTime: Date.now()
    }
  })
  app.post('/api/v1/sync', async (req) => {
    const account = requireAccount(req).id,
      ops = (req.body as { operations?: unknown[] })?.operations
    if (!Array.isArray(ops) || ops.length > 100)
      throw badRequest('invalid_operations', 'Send at most 100 learning actions.')
    if (
      req.via === 'web' &&
      ops.some((o) => /^(exercise|project|quiz|review):/.test(String((o as LearningOperation)?.field)))
    )
      throw badRequest('desktop_only', 'Complete this activity in the app.')
    return push(ctx, account, ops.map(validateOperation))
  })
  app.get('/api/v1/learn/:kind/:id/:version', async (req) => {
    const ref = reference(req.params),
      account = requireAccount(req).id
    contentRecord(ctx, account, ref)
    return ref.kind === 'course'
      ? { course: learnerCourse(await readCourse(ctx, account, ref)), state: state(ctx, account, ref.kind, ref.id) }
      : {
          document: d
            .prepare(
              'SELECT title,description,tags,cover_type,pages,sections,status,error,fingerprint,bytes FROM document_versions WHERE document_id=? AND version=?'
            )
            .get(ref.id, ref.version),
          state: state(ctx, account, ref.kind, ref.id)
        }
  })
  // The cover of the version a learner holds, which stays theirs after the
  // course is unlisted - the catalog's cover is the current, listed one only.
  app.get('/api/v1/learn/:kind/:id/:version/cover', async (req, reply) => {
    const ref = reference(req.params)
    contentRecord(ctx, requireAccount(req).id, ref)
    const cover = coverOf(ref)
    if (!cover) throw notFound()
    // An author's file: as an SVG opened on its own it could carry script.
    return reply
      .type(cover.cover_type)
      .header('Cache-Control', 'private, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .send(createReadStream(cover.cover_path))
  })
  app.get('/api/v1/learn/:kind/:id/:version/download', async (req, reply) => {
    const ref = reference(req.params)
    if (req.via === 'web' && ref.kind === 'course')
      throw forbidden('desktop_only', 'Download this course in the desktop app.')
    const record = contentRecord(ctx, requireAccount(req).id, ref)
    return reply
      .type(ref.kind === 'course' ? 'application/zip' : 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .header('X-OpenCourse-Sha256', record.fingerprint)
      .header('X-OpenCourse-Version', ref.version)
      .header('Content-Length', record.bytes)
      .send(createReadStream(record.path))
  })
  app.get('/api/v1/learn/document/:id/:version/pdf', async (req, reply) => {
    const ref = reference({ ...(req.params as object), kind: 'document' }),
      record = contentRecord(ctx, requireAccount(req).id, ref),
      size = statSync(record.path).size
    reply
      .type('application/pdf')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
    const range = req.headers.range
    if (!range) return reply.header('Content-Length', size).send(createReadStream(record.path))
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) return reply.code(416).header('Content-Range', `bytes */${size}`).send()
    const start = Number(match[1]),
      end = Math.min(size - 1, match[2] ? Number(match[2]) : start + 1024 ** 2 - 1)
    if (start >= size || start > end) return reply.code(416).header('Content-Range', `bytes */${size}`).send()
    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', end - start + 1)
      .send(createReadStream(record.path, { start, end }))
  })
  app.get('/api/v1/learn/document/:id/:version/search', async (req) => {
    const ref = reference({ ...(req.params as object), kind: 'document' })
    contentRecord(ctx, requireAccount(req).id, ref)
    const q = String((req.query as { q?: string }).q ?? '').slice(0, 300)
    if (!q.trim()) return { hits: [] }
    return {
      status: (
        d
          .prepare('SELECT status FROM document_versions WHERE document_id=? AND version=?')
          .get(ref.id, ref.version) as { status: string }
      ).status,
      hits: (
        d
          .prepare(
            'SELECT page,text FROM document_text WHERE document_id=? AND version=? AND instr(lower(text),lower(?))>0 LIMIT 30'
          )
          .all(ref.id, ref.version, q) as { page: number; text: string }[]
      ).map((r) => ({
        page: r.page,
        excerpt: r.text.slice(
          Math.max(0, r.text.toLowerCase().indexOf(q.toLowerCase()) - 100),
          r.text.toLowerCase().indexOf(q.toLowerCase()) + 500
        )
      }))
    }
  })
  app.get('/api/v1/learn/course/:id/:version/assets/*', async (req, reply) => {
    const ref = reference({ ...(req.params as object), kind: 'course' }),
      record = contentRecord(ctx, requireAccount(req).id, ref),
      root = await coursePackage(ctx, record)
    const path = courseAsset(root, `assets/${(req.params as { '*': string })['*']}`)
    return reply
      .type(mime[extname(path)] ?? 'application/octet-stream')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'unsafe-inline' ${ctx.config.publicUrl}/api/v1/learn/course/${ref.id}/${ref.version}/assets/; style-src 'unsafe-inline' ${ctx.config.publicUrl}/api/v1/learn/course/${ref.id}/${ref.version}/assets/; img-src data: ${ctx.config.publicUrl}/api/v1/learn/course/${ref.id}/${ref.version}/assets/; sandbox allow-scripts`
      )
      .send(createReadStream(path))
  })
  app.post('/api/v1/learn/course/:id/:version/quiz/:quiz', async (req) => {
    const ref = reference({ ...(req.params as object), kind: 'course' }),
      account = requireAccount(req).id,
      course = await readCourse(ctx, account, ref)
    const quiz = course.modules
      .flatMap((m) => (m.type === 'project' ? [] : m.lessons.flatMap((l) => l.blocks)))
      .find((b) => b.type === 'quiz' && b.id === (req.params as { quiz: string }).quiz)
    const body = req.body as { submitted: string[]; requestId?: string }
    if (!quiz || quiz.type !== 'quiz') throw notFound()
    if (
      !Array.isArray(body?.submitted) ||
      body.submitted.length > 100 ||
      body.submitted.some((v) => typeof v !== 'string' || v.length > 1000)
    )
      throw badRequest('invalid_answer', 'Invalid quiz answer.')
    const result = grade(quiz, body.submitted),
      s = state(ctx, account, 'course', ref.id),
      at = Date.now()
    push(ctx, account, [
      {
        ...ref,
        generation: s.enrollment.generation,
        epoch: s.epoch,
        idempotencyKey: body.requestId ?? randomUUID(),
        at,
        field: `quiz:${quiz.id}`,
        value: { submitted: body.submitted, isCorrect: result.isCorrect, at: new Date(at).toISOString() }
      }
    ])
    return { ...result, explanation: quiz.explanation }
  })
  app.post('/api/v1/learn/course/:id/:version/cards/:card/reveal', async (req) => {
    const ref = reference({ ...(req.params as object), kind: 'course' }),
      account = requireAccount(req).id,
      course = await readCourse(ctx, account, ref)
    const card = course.modules
      .flatMap((m) => (m.type === 'project' ? [] : m.lessons.flatMap((l) => l.flashcards ?? [])))
      .find((c) => c.id === (req.params as { card: string }).card)
    if (!card) throw notFound()
    const lesson = course.modules
      .flatMap((m) => (m.type === 'project' ? [] : m.lessons))
      .find((l) => l.flashcards?.some((c) => c.id === card.id))!
    if (state(ctx, account, 'course', ref.id).fields[`lesson:${lesson.slug}`]?.value !== true)
      throw badRequest('lesson_incomplete', 'Mark this lesson read to unlock its flashcards.')
    return { answer: card.answer }
  })
  app.post('/api/v1/learn/course/:id/:version/cards/:card/rate', async (req) => {
    const ref = reference({ ...(req.params as object), kind: 'course' }),
      account = requireAccount(req).id
    const course = await readCourse(ctx, account, ref)
    const { card } = req.params as { card: string },
      body = req.body as { rating: ReviewRating; requestId: string }
    if (
      !course.modules.some(
        (m) => m.type !== 'project' && m.lessons.some((l) => l.flashcards?.some((c) => c.id === card))
      )
    )
      throw notFound()
    if (!['again', 'hard', 'good', 'easy'].includes(body?.rating))
      throw badRequest('invalid_rating', 'Choose a review rating.')
    const lesson = course.modules
      .flatMap((m) => (m.type === 'project' ? [] : m.lessons))
      .find((l) => l.flashcards?.some((c) => c.id === card))!
    if (state(ctx, account, 'course', ref.id).fields[`lesson:${lesson.slug}`]?.value !== true)
      throw badRequest('lesson_incomplete', 'Mark this lesson read to unlock its flashcards.')
    const s = state(ctx, account, 'course', ref.id),
      previous = s.fields[`review:${card}`]?.value as { card: StoredCard } | undefined,
      at = Date.now()
    const next = scheduleCard(previous ? deserializeCard(previous.card) : undefined, body.rating, new Date(at))
    push(ctx, account, [
      {
        ...ref,
        generation: s.enrollment.generation,
        epoch: s.epoch,
        idempotencyKey: body.requestId ?? randomUUID(),
        at,
        field: `review:${card}`,
        value: { card: serializeCard(next.card), rating: body.rating }
      }
    ])
    return state(ctx, account, 'course', ref.id)
  })
}
