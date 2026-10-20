/** Durable learning outbox. Ownership is the immutable server/account pair. */
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { db, tx } from './db'
import type { ContentKind, LearningState, LearningOperation } from '../core/learning/types'
import type { CourseProgress } from '../core/types'
import { serverAccess } from './servers'

export const learningEvents = new EventEmitter()
export interface Binding {
  server_id: string
  account_id: string
  connection_id: string
  kind: ContentKind
  remote_id: string
  local_id: string
  version: string
  state: string
  downloaded: number
}
export function bindingFor(localId: string): Binding | null {
  const rows = db().prepare('SELECT * FROM learning_bindings WHERE local_id=?').all(localId) as unknown as Binding[]
  return (
    rows.find((b) => {
      try {
        return serverAccess(b.connection_id).account?.id === b.account_id
      } catch {
        return false
      }
    }) ?? null
  )
}
export function anyBinding(localId: string): Binding | null {
  return (db().prepare('SELECT * FROM learning_bindings WHERE local_id=?').get(localId) as unknown as Binding) ?? null
}
export function scopedId(scope: string, id: string): string {
  const bytes = createHash('sha256').update(`${scope}:${id}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const h = bytes.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
export function remoteId(b: Binding, id: string): string {
  return (
    (
      db()
        .prepare('SELECT remote_id FROM learning_elements WHERE server_id=? AND account_id=? AND local_id=?')
        .get(b.server_id, b.account_id, id) as { remote_id: string } | undefined
    )?.remote_id ?? id
  )
}
export function localId(b: Binding, id: string): string {
  return (
    (
      db()
        .prepare('SELECT local_id FROM learning_elements WHERE server_id=? AND account_id=? AND remote_id=?')
        .get(b.server_id, b.account_id, id) as { local_id: string } | undefined
    )?.local_id ?? id
  )
}
export function mapValue(value: unknown, map: (id: string) => string): unknown {
  if (typeof value === 'string') return /^[a-f\d-]{36}$/i.test(value) ? map(value) : value
  if (Array.isArray(value)) return value.map((v) => mapValue(v, map))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [map(k), mapValue(v, map)]))
  return value
}
export function enqueue(b: Binding, field: string, value: unknown, at = Date.now(), id: string = randomUUID()): void {
  const state = JSON.parse(b.state) as LearningState
  if (!state.enrollment.active) return
  const clock = db()
    .prepare('SELECT clock_offset FROM learning_cursors WHERE server_id=? AND account_id=?')
    .get(b.server_id, b.account_id) as { clock_offset: number } | undefined
  const parts = field.split(':'),
    wireField = parts.length > 1 ? `${parts[0]}:${remoteId(b, parts.slice(1).join(':'))}` : field
  if (/^(project|exercise):/.test(field) && value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    value = {
      ...(v.startedAt ? { startedAt: v.startedAt } : {}),
      ...(v.completedAt ? { completedAt: v.completedAt } : {})
    }
  }
  if (field.startsWith('review:') && value && typeof value === 'object')
    value = { rating: (value as { rating: string }).rating }
  const operation: LearningOperation = {
    kind: b.kind,
    id: b.remote_id,
    version: b.version,
    generation: state.enrollment.generation,
    epoch: state.epoch,
    at: at + (clock?.clock_offset ?? 0),
    idempotencyKey: id,
    field: wireField,
    // Code is the learner's text: a line that happens to be an id stays as written.
    value: field.startsWith('code:') ? value : mapValue(value, (v) => remoteId(b, v))
  }
  db()
    .prepare('INSERT OR IGNORE INTO learning_outbox(id,server_id,account_id,payload) VALUES(?,?,?,?)')
    .run(id, b.server_id, b.account_id, JSON.stringify(operation))
  learningEvents.emit('pending')
}
export function queueDocument(id: string, field: 'position' | 'readPage', value: number, mutate: () => void): void {
  tx(() => {
    mutate()
    const b = anyBinding(id)
    if (b) enqueue(b, field, value)
  })
}
export function journalProgress(before: CourseProgress, after: CourseProgress): boolean {
  const b = anyBinding(after.courseId)
  if (!b) return false
  tx(() => {
    const old = new Set(before.completedLessons),
      next = new Set(after.completedLessons)
    for (const id of new Set([...old, ...next]))
      if (old.has(id) !== next.has(id)) enqueue(b, `lesson:${id}`, next.has(id))
    for (const [field, key] of [
      ['quiz', 'quizAttempts'],
      ['exercise', 'exercises'],
      ['project', 'projects']
    ] as const)
      for (const id of new Set([...Object.keys(before[key]), ...Object.keys(after[key])]))
        if (JSON.stringify(before[key][id]) !== JSON.stringify(after[key][id]))
          enqueue(b, `${field}:${id}`, after[key][id] ?? null)
    if (JSON.stringify(before.lastItem) !== JSON.stringify(after.lastItem))
      enqueue(b, 'lastItem', after.lastItem ?? null)
    db()
      .prepare(
        'INSERT INTO learning_progress_journal(local_id,value) VALUES(?,?) ON CONFLICT(local_id) DO UPDATE SET value=excluded.value'
      )
      .run(after.courseId, JSON.stringify(after))
  })
  return true
}

/** Preference changes and their sync operations share one SQLite transaction. */
export function learningPreference(
  local: string,
  name: 'readingScale' | 'pdfZoom',
  value?: number
): { value?: number } | null {
  if (!['readingScale', 'pdfZoom'].includes(name)) throw new Error('Unknown learning preference.')
  const b = anyBinding(local)
  if (!b) return null
  const field = `preference:${name}`,
    state = JSON.parse(b.state) as LearningState
  if (value !== undefined) {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > (name === 'readingScale' ? 2 : 3) ||
      (name === 'readingScale' && value < 0.5)
    )
      throw new Error('Invalid reading size.')
    tx(() => {
      const id = randomUUID(),
        at = Date.now()
      enqueue(b, field, value, at, id)
      state.fields[field] = { value, at, operation: id }
      db().prepare('UPDATE learning_bindings SET state=? WHERE local_id=?').run(JSON.stringify(state), local)
    })
  }
  let result = state.fields[field]?.value
  for (const row of db()
    .prepare('SELECT payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL ORDER BY rowid')
    .all(b.server_id, b.account_id) as { payload: string }[]) {
    const op = JSON.parse(row.payload) as LearningOperation
    if (
      op.kind === b.kind &&
      op.id === b.remote_id &&
      op.field === field &&
      op.epoch === state.epoch &&
      op.generation === state.enrollment.generation &&
      (b.kind === 'course' || op.version === b.version)
    )
      result = op.value
  }
  return { value: typeof result === 'number' ? result : undefined }
}
