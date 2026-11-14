/**
 * The log's rows, and the sink that writes them.
 *
 * Statements only - the handle and its migrations are db.ts's, like every other
 * query file. Reads are bounded the way the rest of the app's are: a page at a
 * time, and the owner clause from core/logging/query.ts on every one, so a user
 * reads their own lines and the general ones and nobody else's.
 *
 * Writes are batched. DatabaseSync blocks the main process, and a log line is
 * written from the middle of things that should not wait on a disk - so the
 * sink queues, and flushes once per tick (or when the queue is long) in one
 * transaction. A write that fails is reported to stderr, never to `log`: the
 * log is what failed, and telling it so would loop.
 */
import type { DatabaseSync } from 'node:sqlite'
import { LEVEL_RANK, levelOfRank, type LogLevel, type LogRecord, type LogSink } from '../core/logging/types'
import { buildLogSql, ownerClause, type LogPage, type LogQuery, type LogRow } from '../core/logging/query'
import { logDb } from './db'

/** Thirty days, then a line goes. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000
/** And never more than this many, whatever their age. */
export const LOG_MAX_ROWS = 50_000
/** How many inserts between re-prunes while the app runs. */
const PRUNE_EVERY = 1_000

let pruned: DatabaseSync | null = null

/** The handle, pruned once each time it is (re)opened. */
function handle(): DatabaseSync {
  const d = logDb()
  if (pruned !== d) {
    pruned = d
    pruneLogs(d)
  }
  return d
}

export function pruneLogs(d: DatabaseSync = logDb(), now = Date.now()): void {
  d.prepare('DELETE FROM logs WHERE at < ?').run(now - LOG_RETENTION_MS)
  // The id of the newest line that is one too many; everything at or below it goes.
  const over = d.prepare('SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?').get(LOG_MAX_ROWS) as { id: number } | undefined
  if (over) d.prepare('DELETE FROM logs WHERE id <= ?').run(over.id)
}

export function insertLogs(records: readonly LogRecord[]): void {
  if (!records.length) return
  const d = handle()
  const insert = d.prepare('INSERT INTO logs (at, level, scope, message, user_id, data) VALUES (?, ?, ?, ?, ?, ?)')
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const r of records) {
      insert.run(r.at, LEVEL_RANK[r.level], r.scope, r.message, r.userId, r.data ? JSON.stringify(r.data) : null)
    }
    d.exec('COMMIT')
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* the transaction is already gone */
    }
    throw err
  }
}

interface RawRow {
  id: number
  at: number
  level: number
  scope: string
  message: string
  user_id: string | null
  data: string | null
}

function parseData(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw: text }
  }
}

function toRow(raw: RawRow): LogRow {
  return {
    id: Number(raw.id),
    at: Number(raw.at),
    level: levelOfRank(Number(raw.level)),
    scope: raw.scope,
    message: raw.message,
    mine: raw.user_id !== null,
    data: parseData(raw.data)
  }
}

/**
 * One page, and how many lines match in all. A page past the end - a filter
 * narrowed what was page 7 down to three pages - serves the last page instead
 * of an empty table that reads like "no logs".
 */
export function selectLogs(query: LogQuery, userId: string): LogPage {
  const d = handle()
  const sql = buildLogSql(query, userId)
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ${sql.where}`).get(...sql.params) as { n: number }).n)
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, lastPage)
  const rows = d
    .prepare(`SELECT id, at, level, scope, message, user_id, data FROM logs WHERE ${sql.where} ORDER BY ${sql.orderBy} LIMIT ? OFFSET ?`)
    .all(...sql.params, query.pageSize, (page - 1) * query.pageSize) as unknown as RawRow[]
  return { rows: rows.map(toRow), total, page, query: { ...query, page } }
}

/** The scopes this user can see lines from, for the filter. A handful, by construction. */
export function selectLogScopes(userId: string): string[] {
  const owner = ownerClause('all', userId)
  const rows = handle()
    .prepare(`SELECT DISTINCT scope FROM logs WHERE ${owner.sql} ORDER BY scope COLLATE NOCASE LIMIT 200`)
    .all(...owner.params) as { scope: string }[]
  return rows.map((r) => r.scope)
}

/** A deleted user's lines go with them; the general ones stay. */
export function deleteUserLogs(userId: string): void {
  handle().prepare('DELETE FROM logs WHERE user_id = ?').run(userId)
}

/** The longest the queue may grow while writes are failing or the tick is busy. */
const MAX_QUEUE = 1_000
/** A batch this long is written now rather than at the end of the tick. */
const FLUSH_AT = 100
/** After a failed write, how long to drop lines before trying the disk again. */
const RETRY_AFTER_MS = 60_000

export interface DatabaseSinkOptions {
  minLevel: LogLevel
  /** Test seam: what to do with a line that could not be written. */
  report?: (text: string) => void
}

export function databaseSink(options: DatabaseSinkOptions): LogSink {
  const report = options.report ?? ((text: string) => process.stderr.write(`${text}\n`))
  let queue: LogRecord[] = []
  let scheduled = false
  let brokenUntil = 0
  let dropped = 0
  let sincePrune = 0

  const flush = (): void => {
    scheduled = false
    if (!queue.length) return
    const batch = queue
    queue = []
    if (Date.now() < brokenUntil) {
      dropped += batch.length
      return
    }
    try {
      insertLogs(batch)
      sincePrune += batch.length
      if (sincePrune >= PRUNE_EVERY) {
        sincePrune = 0
        pruneLogs(logDb())
      }
      if (dropped) {
        const lost = dropped
        dropped = 0
        insertLogs([{ at: Date.now(), level: 'warn', scope: 'log', message: `${lost} log lines were dropped while the log could not be written`, userId: null }])
      }
    } catch (err) {
      dropped += batch.length
      brokenUntil = Date.now() + RETRY_AFTER_MS
      report(`[log] could not write ${batch.length} lines to logs.db: ${(err as Error).message}`)
    }
  }

  return {
    name: 'database',
    minLevel: options.minLevel,
    write: (record) => {
      queue.push(record)
      if (queue.length > MAX_QUEUE) {
        dropped += queue.length - MAX_QUEUE
        queue = queue.slice(-MAX_QUEUE)
      }
      if (queue.length >= FLUSH_AT) flush()
      else if (!scheduled) {
        scheduled = true
        setImmediate(flush)
      }
    },
    flush,
    close: flush
  }
}
