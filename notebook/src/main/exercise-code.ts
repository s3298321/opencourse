/**
 * An exercise's code, kept in step with the web.
 *
 * The file on disk stays the source of truth on this machine; `code:<exercise>`
 * is how the same text reaches a server and comes back from one. Both sides can
 * change between two syncs, so each exercise remembers the last text the two
 * agreed on (`learning_exercise_code`): whichever side moved since is the one
 * to copy, and when both moved the later edit wins - the file's mtime against
 * the server's action time.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { db, tx } from './db'
import { anyBinding, enqueue, remoteId, type Binding } from './learning-store'
import { MAX_EXERCISE_CODE, newer, type LearningField, type LearningOperation, type LearningState } from '../core/learning/types'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The server's code for this exercise, with this machine's unsent edits on top. */
function syncedCode(b: Binding, field: string): LearningField | null {
  const state = JSON.parse(b.state) as LearningState
  let result = state.fields[field] ?? null
  const pending = db()
    .prepare('SELECT payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL ORDER BY rowid')
    .all(b.server_id, b.account_id) as { payload: string }[]
  for (const row of pending) {
    const o = JSON.parse(row.payload) as LearningOperation
    if (
      o.kind === b.kind &&
      o.id === b.remote_id &&
      o.field === field &&
      o.epoch === state.epoch &&
      o.generation === state.enrollment.generation &&
      newer({ at: o.at, operation: o.idempotencyKey }, result ?? undefined)
    )
      result = { value: o.value, at: o.at, operation: o.idempotencyKey }
  }
  return result
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export type CodeSync = 'pulled' | 'pushed' | 'same' | 'unbound'

/**
 * Brings the learner's file and the synced code together. `fresh` means the
 * file was only just scaffolded from the starter, so it holds nothing of the
 * learner's and must not be pushed over code written elsewhere.
 */
export function reconcileExerciseCode(courseId: string, blockId: string, path: string, fresh = false): CodeSync {
  const b = anyBinding(courseId)
  if (!b || b.kind !== 'course') return 'unbound'
  const state = JSON.parse(b.state) as LearningState
  if (!state.enrollment.active) return 'unbound'
  const field = `code:${remoteId(b, blockId)}`,
    remote = syncedCode(b, field),
    last = db()
      .prepare('SELECT operation,hash FROM learning_exercise_code WHERE local_id=? AND block_id=?')
      .get(courseId, blockId) as { operation: string; hash: string } | undefined,
    local = existsSync(path) ? { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs } : null,
    offset =
      (
        db()
          .prepare('SELECT clock_offset FROM learning_cursors WHERE server_id=? AND account_id=?')
          .get(b.server_id, b.account_id) as { clock_offset: number } | undefined
      )?.clock_offset ?? 0
  const remember = (operation: string, text: string): void => {
    db()
      .prepare(
        'INSERT INTO learning_exercise_code(local_id,block_id,operation,hash) VALUES(?,?,?,?) ON CONFLICT(local_id,block_id) DO UPDATE SET operation=excluded.operation,hash=excluded.hash'
      )
      .run(courseId, blockId, operation, digest(text))
  }
  const remoteText = typeof remote?.value === 'string' ? remote.value : null,
    localMoved = Boolean(local && !fresh && digest(local.text) !== last?.hash),
    remoteMoved = remoteText !== null && (fresh || remote!.operation !== last?.operation)
  if (
    remoteText !== null &&
    remoteMoved &&
    (!localMoved || !local || local.mtimeMs + offset <= remote!.at)
  ) {
    if (local?.text !== remoteText) writeAtomically(path, remoteText)
    remember(remote!.operation, remoteText)
    return local?.text === remoteText ? 'same' : 'pulled'
  }
  if (local && localMoved && local.text !== remoteText && local.text.length <= MAX_EXERCISE_CODE) {
    const operation = randomUUID()
    tx(() => {
      // Only the newest unsent draft matters: an autosave every second must not
      // become a queue of every draft in between.
      for (const row of db()
        .prepare('SELECT id,payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL')
        .all(b.server_id, b.account_id) as { id: string; payload: string }[]) {
        const o = JSON.parse(row.payload) as LearningOperation
        if (o.kind === b.kind && o.id === b.remote_id && o.field === field)
          db().prepare('DELETE FROM learning_outbox WHERE id=?').run(row.id)
      }
      enqueue(b, `code:${blockId}`, local.text, Date.now(), operation)
      remember(operation, local.text)
    })
    return 'pushed'
  }
  if (local && remote && local.text === remoteText) remember(remote.operation, local.text)
  return 'same'
}
