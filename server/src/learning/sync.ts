import { scheduleCard, serializeCard } from '@core/review'
import type { ReviewRating } from '@core/types'
import { randomUUID } from 'node:crypto'
import type { Ctx } from '../context'
import { conflict, badRequest } from '../errors'
import { tx } from '../db'
import { recordAcquisition } from '../catalog/catalog'
import { contentRecord, currentVersion } from './content'
import {
  actionTime,
  newer,
  learningKey,
  SYNC_FIELDS,
  MAX_EXERCISE_CODE,
  type ContentKind,
  type ContentRef,
  type Enrollment,
  type LearningState,
  type LearningOperation,
  type LearningField,
  type SyncResult
} from '@core/learning/types'

export function change(ctx: Ctx, account: string, type: 'state' | 'chat', key: string, value: unknown): void {
  // A state change is the whole state, so a newer one supersedes it for every
  // cursor: keep the feed at one row per item rather than one per action -
  // exercise code is saved every few seconds while someone types.
  if (type === 'state')
    ctx.db
      .prepare("DELETE FROM learning_changes WHERE account_id=? AND type='state' AND key=?")
      .run(account, key)
  ctx.db
    .prepare('INSERT INTO learning_changes(account_id,type,key,value) VALUES(?,?,?,?)')
    .run(account, type, key, JSON.stringify(value))
}
export function enrollment(ctx: Ctx, account: string, kind: ContentKind, id: string): Enrollment | null {
  const row = ctx.db
    .prepare('SELECT * FROM enrollments WHERE account_id=? AND kind=? AND content_id=?')
    .get(account, kind, id) as Record<string, unknown> | undefined
  return row
    ? {
        kind,
        id,
        version: String(row.version),
        generation: String(row.generation),
        active: Boolean(row.active),
        title: String(row.title),
        updatedAt: String(row.updated_at)
      }
    : null
}
export function state(ctx: Ctx, account: string, kind: ContentKind, id: string): LearningState {
  const entry = enrollment(ctx, account, kind, id)
  if (!entry) throw conflict('not_enrolled', 'Add this item to My learning first.')
  const epoch = String(
    (
      ctx.db
        .prepare('SELECT epoch FROM enrollments WHERE account_id=? AND kind=? AND content_id=?')
        .get(account, kind, id) as { epoch: string }
    ).epoch
  )
  const scope = progressScope(ctx, entry)
  const rows = ctx.db
    .prepare(
      'SELECT field,value,at,operation FROM learning_fields WHERE account_id=? AND kind=? AND content_id=? AND scope=? AND epoch=?'
    )
    .all(account, kind, id, scope, epoch) as { field: string; value: string; at: number; operation: string }[]
  const fields: Record<string, LearningField> = Object.create(null)
  for (const row of rows) fields[row.field] = { value: JSON.parse(row.value), at: row.at, operation: row.operation }
  return { enrollment: entry, epoch, fields }
}
function progressScope(ctx: Ctx, ref: ContentRef): string {
  if (ref.kind === 'course') return ''
  const row = ctx.db
    .prepare('SELECT fingerprint FROM document_versions WHERE document_id=? AND version=?')
    .get(ref.id, ref.version) as { fingerprint: string } | undefined
  return row?.fingerprint ?? ref.version
}
export function enroll(ctx: Ctx, account: string, kind: ContentKind, id: string, version?: string): LearningState {
  const existing = enrollment(ctx, account, kind, id)
  const selected = version ?? (existing?.active ? existing.version : currentVersion(ctx, kind, id))
  const record = contentRecord(ctx, account, { kind, id, version: selected }, true)
  return tx(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO enrollments(account_id,kind,content_id,version,generation,active,title,updated_at) VALUES(?,?,?,?,?,1,?,?)
      ON CONFLICT(account_id,kind,content_id) DO UPDATE SET version=excluded.version,generation=excluded.generation,active=1,title=excluded.title,updated_at=excluded.updated_at`
      )
      .run(
        account,
        kind,
        id,
        selected,
        existing?.active ? existing.generation : randomUUID(),
        record.title,
        new Date().toISOString()
      )
    if (kind === 'course' && (!existing || existing.version !== selected))
      recordAcquisition(ctx.db, id, account, selected, existing ? 'update' : 'add')
    const value = state(ctx, account, kind, id)
    change(ctx, account, 'state', learningKey(kind, id), value)
    return value
  })
}
export function unenroll(ctx: Ctx, account: string, kind: ContentKind, id: string): void {
  tx(ctx.db, () => {
    ctx.db
      .prepare(
        'UPDATE enrollments SET active=0,generation=?,updated_at=? WHERE account_id=? AND kind=? AND content_id=?'
      )
      .run(randomUUID(), new Date().toISOString(), account, kind, id)
    if (enrollment(ctx, account, kind, id))
      change(ctx, account, 'state', learningKey(kind, id), state(ctx, account, kind, id))
  })
}
export function validateOperation(raw: unknown): LearningOperation {
  if (!raw || typeof raw !== 'object') throw badRequest('invalid_operation', 'Invalid learning action.')
  const input = raw as LearningOperation
  const o: LearningOperation = {
    kind: input.kind,
    id: input.id,
    version: input.version,
    idempotencyKey: input.idempotencyKey,
    generation: input.generation,
    epoch: input.epoch,
    at: input.at,
    field: input.field,
    value: input.value
  }
  if (
    !['course', 'document'].includes(o.kind) ||
    !/^[a-f0-9-]{36}$/.test(o.id) ||
    typeof o.version !== 'string' ||
    o.version.length > 40 ||
    typeof o.idempotencyKey !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(o.idempotencyKey) ||
    typeof o.generation !== 'string' ||
    o.generation.length > 64 ||
    typeof o.epoch !== 'string' ||
    o.epoch.length > 160 ||
    !Number.isFinite(o.at) ||
    typeof o.field !== 'string' ||
    !SYNC_FIELDS.test(o.field) ||
    (!o.field.startsWith('code:') && JSON.stringify(o.value ?? null).length > 16000)
  )
    throw badRequest('invalid_operation', 'Invalid learning action.')
  if (
    ['preference:readingScale', 'preference:pdfZoom'].includes(o.field) &&
    (typeof o.value !== 'number' ||
      !Number.isFinite(o.value) ||
      o.value <= 0 ||
      o.value > (o.field === 'preference:readingScale' ? 2 : 3) ||
      (o.field === 'preference:readingScale' && o.value < 0.5))
  )
    throw badRequest('invalid_operation', 'Invalid reading size.')
  const prefix = o.field.split(':')[0]
  if (prefix === 'lesson' && typeof o.value !== 'boolean')
    throw badRequest('invalid_operation', 'Completion must be a boolean.')
  if (
    ['readPage', 'position'].includes(prefix) &&
    (!Number.isInteger(o.value) || Number(o.value) < 0 || Number(o.value) > 100000)
  )
    throw badRequest('invalid_operation', 'Invalid page.')
  if (o.kind === 'document' && !['position', 'readPage', 'preference', 'reset'].includes(prefix))
    throw badRequest('invalid_operation', 'Invalid document action.')
  if (
    ['lesson', 'quiz', 'exercise', 'code', 'project', 'review'].includes(prefix) &&
    !/^[a-f0-9-]{36}$/.test(o.field.slice(prefix.length + 1))
  )
    throw badRequest('invalid_operation', 'Invalid element identity.')
  if (prefix === 'code' && o.value !== null && (typeof o.value !== 'string' || o.value.length > MAX_EXERCISE_CODE))
    throw badRequest('invalid_operation', 'This code is too long to save.')
  const value = o.value as Record<string, unknown> | null
  if (
    value &&
    typeof value === 'object' &&
    Object.keys(value).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k))
  )
    throw badRequest('invalid_operation', 'Invalid action value.')
  if (
    prefix === 'review' &&
    value !== null &&
    (!value || !['again', 'hard', 'good', 'easy'].includes(String(value.rating)))
  )
    throw badRequest('invalid_operation', 'Invalid review rating.')
  if (
    prefix === 'quiz' &&
    value !== null &&
    (!value ||
      !Array.isArray(value.submitted) ||
      value.submitted.some((x) => typeof x !== 'string' || x.length > 1000) ||
      typeof value.isCorrect !== 'boolean' ||
      typeof value.at !== 'string')
  )
    throw badRequest('invalid_operation', 'Invalid quiz result.')
  // Only completion summaries leave the desktop, and the learner's own code under `code:`.
  // Review provenance and local file fingerprints stay there.
  if (['exercise', 'project'].includes(prefix) && value)
    return {
      ...o,
      value: {
        ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
        ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {})
      }
    }
  if (prefix === 'review' && value) return { ...o, value: { rating: value.rating } }
  if (
    prefix === 'lastItem' &&
    value &&
    (!['lesson', 'project'].includes(String(value.kind)) ||
      !/^[a-f0-9-]{36}$/.test(String(value.moduleId)) ||
      (value.kind === 'lesson' && !/^[a-f0-9-]{36}$/.test(String(value.lessonId))))
  )
    throw badRequest('invalid_operation', 'Invalid reading position.')
  if (prefix === 'quiz' && value)
    return { ...o, value: { submitted: value.submitted, isCorrect: value.isCorrect, at: value.at } }
  if (prefix === 'lastItem' && value)
    return {
      ...o,
      value: {
        kind: value.kind,
        moduleId: value.moduleId,
        ...(value.kind === 'lesson' ? { lessonId: value.lessonId } : {})
      }
    }
  return { ...o, value: o.value ?? null }
}
export function push(ctx: Ctx, account: string, operations: LearningOperation[]): SyncResult {
  const result: SyncResult = { accepted: [], rejected: [], serverTime: Date.now() }
  tx(ctx.db, () => {
    for (const operation of operations) {
      const o = validateOperation(operation),
        d = ctx.db
      if (
        d.prepare('SELECT 1 FROM learning_events WHERE account_id=? AND operation=?').get(account, o.idempotencyKey)
      ) {
        result.accepted.push(o.idempotencyKey)
        continue
      }
      const entry = enrollment(ctx, account, o.kind, o.id)
      const current = entry ? state(ctx, account, o.kind, o.id) : null
      if (!entry?.active || entry.generation !== o.generation || !current || o.epoch !== current.epoch) {
        result.rejected.push({ id: o.idempotencyKey, code: 'stale_generation' })
        continue
      }
      // Versions may differ while a device is offline, but they must belong to this source.
      const validVersion = d
        .prepare(
          `SELECT 1 FROM ${o.kind === 'course' ? 'course_versions WHERE course_id' : 'document_versions WHERE document_id'}=? AND version=?`
        )
        .get(o.id, o.version)
      if (!validVersion) {
        result.rejected.push({ id: o.idempotencyKey, code: 'unknown_version' })
        continue
      }
      const [field, element] = o.field.split(':')
      if (
        ['lesson', 'quiz', 'exercise', 'code', 'project', 'review'].includes(field) &&
        !d
          .prepare('SELECT 1 FROM elements WHERE uid=? AND course_id=? AND kind=?')
          .get(element, o.id, field === 'review' ? 'flashcard' : field === 'code' ? 'exercise' : field)
      ) {
        result.rejected.push({ id: o.idempotencyKey, code: 'unknown_element' })
        continue
      }
      o.at = actionTime(o.at, result.serverTime)
      // The event is the idempotency record. Code is already in learning_fields,
      // and keeping every saved draft here would keep everything ever typed.
      d.prepare('INSERT INTO learning_events(account_id,operation,payload) VALUES(?,?,?)').run(
        account,
        o.idempotencyKey,
        JSON.stringify(o.field.startsWith('code:') ? { ...o, value: null } : o)
      )
      const scope = progressScope(ctx, o)
      if (o.field === 'reset') {
        d.prepare('UPDATE enrollments SET epoch=? WHERE account_id=? AND kind=? AND content_id=?').run(
          o.idempotencyKey,
          account,
          o.kind,
          o.id
        )
      } else {
        const before = d
          .prepare(
            'SELECT at,operation FROM learning_fields WHERE account_id=? AND kind=? AND content_id=? AND scope=? AND field=? AND epoch=?'
          )
          .get(account, o.kind, o.id, scope, o.field, o.epoch) as LearningField | undefined
        if (newer({ at: o.at, operation: o.idempotencyKey }, before))
          d.prepare(
            `INSERT INTO learning_fields(account_id,kind,content_id,scope,field,value,at,operation,epoch) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_id,kind,content_id,scope,field) DO UPDATE SET value=excluded.value,at=excluded.at,operation=excluded.operation,epoch=excluded.epoch`
          ).run(account, o.kind, o.id, scope, o.field, JSON.stringify(o.value), o.at, o.idempotencyKey, o.epoch)
      }
      if (o.field.startsWith('review:')) {
        // Rebuild in action order so offline delivery order cannot change the schedule.
        const events = (
          d
            .prepare(
              `SELECT payload FROM learning_events WHERE account_id=? AND json_extract(payload,'$.id')=? AND json_extract(payload,'$.field')=? AND json_extract(payload,'$.epoch')=? ORDER BY json_extract(payload,'$.at'),operation`
            )
            .all(account, o.id, o.field, o.epoch) as { payload: string }[]
        ).map((r) => JSON.parse(r.payload) as LearningOperation)
        let card: ReturnType<typeof scheduleCard>['card'] | undefined
        for (const event of events)
          card =
            event.value === null
              ? undefined
              : scheduleCard(card, (event.value as { rating: ReviewRating }).rating, new Date(event.at)).card
        const last = events.at(-1)!
        d.prepare(
          'UPDATE learning_fields SET value=?,at=?,operation=? WHERE account_id=? AND kind=? AND content_id=? AND scope=? AND field=?'
        ).run(
          JSON.stringify(
            card ? { card: serializeCard(card), rating: (last.value as { rating: ReviewRating }).rating } : null
          ),
          last.at,
          last.idempotencyKey,
          account,
          o.kind,
          o.id,
          scope,
          o.field
        )
      }
      change(ctx, account, 'state', learningKey(o.kind, o.id), state(ctx, account, o.kind, o.id))
      result.accepted.push(o.idempotencyKey)
    }
  })
  return result
}
