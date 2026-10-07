/**
 * The log, against a real logs.db. What matters: a user reads their lines and
 * the general ones and never another user's; the table stays bounded; a
 * deleted user's lines go with them; and a broken file costs old lines, never
 * the app or the next line.
 */
// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLevel, LogRecord } from '../src/core/logging/types'

const root = mkdtempSync(join(tmpdir(), 'opencourse-logs-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false,
    on: () => {}
  }
}))

const { createUser, switchUser } = await import('../src/main/users')
const { closeLogDb, logDb, LOG_SCHEMA_VERSION } = await import('../src/main/db')
const { logDbFile } = await import('../src/main/paths')
const { LOG_MAX_ROWS, LOG_RETENTION_MS, databaseSink, deleteUserLogs, insertLogs, pruneLogs, selectLogScopes, selectLogs } = await import('../src/main/logdb')
const { normalizeLogQuery } = await import('../src/core/logging/query')
const { log } = await import('../src/main/log')
const { installLogSinks } = await import('../src/main/logging')

afterAll(() => {
  closeLogDb()
  rmSync(root, { recursive: true, force: true })
})

let n = 0
beforeEach(() => {
  closeLogDb()
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
})

const NOW = Date.now()
function line(over: Partial<LogRecord> & { level?: LogLevel } = {}): LogRecord {
  return { at: NOW, level: 'info', scope: 'app', message: 'hello', userId: null, ...over }
}
const page = (raw: unknown, userId: string) => selectLogs(normalizeLogQuery(raw), userId)

describe('the file', () => {
  it('lives at userData/logs.db, app-wide, with its own schema version', () => {
    logDb()
    expect(logDbFile()).toBe(join(dataDir, 'logs.db'))
    expect(existsSync(logDbFile())).toBe(true)
    const row = logDb().prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(LOG_SCHEMA_VERSION)
  })

  it('is set aside and started again when it is unreadable', () => {
    writeFileSync(join(dataDir, 'logs.db'), 'this is not a database, it is a sentence')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    insertLogs([line({ message: 'after the break' })])
    stderr.mockRestore()
    expect(readdirSync(dataDir).some((f) => f.startsWith('logs.db.broken-'))).toBe(true)
    expect(page({}, 'u_x').rows.map((r) => r.message)).toEqual(['after the break'])
  })
})

describe('whose lines a user reads', () => {
  beforeEach(() => {
    insertLogs([
      line({ at: NOW - 3000, message: 'general one' }),
      line({ at: NOW - 2000, message: 'ada one', userId: 'u_ada' }),
      line({ at: NOW - 1000, message: 'bob one', userId: 'u_bob' }),
      line({ at: NOW, message: 'ada two', userId: 'u_ada', level: 'error' })
    ])
  })

  it('their own and the general ones, never another user\'s', () => {
    const all = page({}, 'u_ada')
    expect(all.rows.map((r) => r.message)).toEqual(['ada two', 'ada one', 'general one'])
    expect(all.rows.map((r) => r.mine)).toEqual([true, true, false])
    expect(all.total).toBe(3)
    expect(page({ owner: 'mine' }, 'u_ada').rows.map((r) => r.message)).toEqual(['ada two', 'ada one'])
    expect(page({ owner: 'general' }, 'u_ada').rows.map((r) => r.message)).toEqual(['general one'])
    expect(JSON.stringify(page({ owner: 'all' }, 'u_ada'))).not.toContain('bob')
  })

  it('cannot reach another user\'s lines by searching for them', () => {
    expect(page({ search: 'bob' }, 'u_ada').rows).toEqual([])
  })

  it('sees the scopes of their own lines and the general ones', () => {
    insertLogs([line({ scope: 'openai', userId: 'u_ada' }), line({ scope: 'secret-bob-thing', userId: 'u_bob' })])
    expect(selectLogScopes('u_ada')).toEqual(['app', 'openai'])
  })

  it('loses their lines when they are deleted, and nobody else does', () => {
    deleteUserLogs('u_ada')
    expect(page({}, 'u_ada').rows.map((r) => r.message)).toEqual(['general one'])
    expect(page({ owner: 'mine' }, 'u_bob').rows.map((r) => r.message)).toEqual(['bob one'])
  })
})

describe('paging, sorting and filtering', () => {
  beforeEach(() => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    insertLogs(Array.from({ length: 30 }, (_, i) => line({
      at: NOW - (30 - i) * 1000,
      level: levels[i % 4]!,
      scope: i % 2 ? 'openai' : 'chat',
      message: `line ${String(i).padStart(2, '0')}${i === 7 ? ' 100% done' : ''}`,
      userId: 'u_a',
      data: { index: i }
    })))
  })

  it('pages newest first, with a total', () => {
    const first = page({ pageSize: 10 }, 'u_a')
    expect(first.total).toBe(30)
    expect(first.rows).toHaveLength(10)
    expect(first.rows[0]!.message).toBe('line 29')
    expect(first.rows[0]!.data).toEqual({ index: 29 })
    const third = page({ pageSize: 10, page: 3 }, 'u_a')
    expect(third.rows.at(-1)!.message).toBe('line 00')
  })

  it('serves the last page rather than an empty one past the end', () => {
    const past = page({ pageSize: 10, page: 9 }, 'u_a')
    expect(past.page).toBe(3)
    expect(past.query.page).toBe(3)
    expect(past.rows).toHaveLength(10)
  })

  it('sorts by severity, and by time either way', () => {
    const worst = page({ sort: { column: 'level', dir: 'desc' }, pageSize: 10 }, 'u_a')
    // Seven errors in thirty, then the warnings.
    expect(worst.rows.map((r) => r.level)).toEqual([...Array(7).fill('error'), 'warn', 'warn', 'warn'])
    expect(worst.rows[0]!.message).toBe('line 27')
    expect(page({ sort: { column: 'at', dir: 'asc' } }, 'u_a').rows[0]!.message).toBe('line 00')
    const byScope = page({ sort: { column: 'scope', dir: 'asc' }, pageSize: 100 }, 'u_a').rows.map((r) => r.scope)
    expect(byScope.indexOf('openai')).toBe(15)
  })

  it('filters by level, scope, search and time', () => {
    expect(page({ levels: ['error', 'warn'] }, 'u_a').total).toBe(14)
    expect(page({ scopes: ['openai'] }, 'u_a').total).toBe(15)
    expect(page({ search: '100%' }, 'u_a').rows.map((r) => r.message)).toEqual(['line 07 100% done'])
    expect(page({ search: '"index":12' }, 'u_a').rows.map((r) => r.message)).toEqual(['line 12'])
    expect(page({ from: NOW - 5000, to: NOW - 3000 }, 'u_a').rows.map((r) => r.message)).toEqual(['line 27', 'line 26', 'line 25'])
  })
})

describe('staying bounded', () => {
  it('drops lines older than thirty days', () => {
    insertLogs([line({ at: NOW - LOG_RETENTION_MS - 1, message: 'too old' }), line({ message: 'recent' })])
    pruneLogs(logDb(), NOW)
    expect(page({}, 'u').rows.map((r) => r.message)).toEqual(['recent'])
  })

  it('keeps no more than the newest fifty thousand', () => {
    insertLogs(Array.from({ length: LOG_MAX_ROWS + 25 }, (_, i) => line({ at: NOW - 1_000_000 + i, message: `n${i}` })))
    pruneLogs(logDb(), NOW)
    const kept = page({ sort: { column: 'at', dir: 'asc' }, pageSize: 10 }, 'u')
    expect(kept.total).toBe(LOG_MAX_ROWS)
    expect(kept.rows[0]!.message).toBe('n25')
  })
})

describe('the database sink', () => {
  it('batches until the tick ends, and a flush writes what is queued', async () => {
    const sink = databaseSink({ minLevel: 'info' })
    sink.write(line({ message: 'queued' }))
    expect(page({}, 'u').total).toBe(0)
    sink.flush!()
    expect(page({}, 'u').total).toBe(1)
    sink.write(line({ message: 'next tick' }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(page({}, 'u').total).toBe(2)
  })

  it('reports a failed write instead of throwing, and drops lines until it is worth trying again', () => {
    const report = vi.fn()
    const sink = databaseSink({ minLevel: 'info', report })
    const broken = { ...line(), level: 'nonsense' as LogLevel }
    sink.write(broken)
    expect(() => sink.flush!()).not.toThrow()
    expect(report).toHaveBeenCalledTimes(1)
    sink.write(line({ message: 'during the pause' }))
    sink.flush!()
    expect(page({}, 'u').total).toBe(0)
  })

  it('stamps the selected user and keeps keys out, end to end through the app logger', () => {
    process.env['OPENCOURSE_LOG_CONSOLE'] = '0'
    installLogSinks()
    delete process.env['OPENCOURSE_LOG_CONSOLE']
    log.info('before anyone')
    const ada = createUser('Ada')
    log.child('openai').error('OpenAI rejected sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', { header: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' })
    const bob = createUser('Bob')
    log.info('as Bob')
    switchUser(ada.id)
    log.flush()
    const seen = page({}, ada.id)
    expect(seen.rows.map((r) => [r.message.slice(0, 16), r.mine])).toEqual([
      ['OpenAI rejected ', true],
      ['before anyone', false]
    ])
    expect(JSON.stringify(seen)).not.toContain('sk-proj')
    expect(page({ owner: 'mine' }, bob.id).rows.map((r) => r.message)).toEqual(['as Bob'])
    for (const sink of log.sinks()) log.removeSink(sink.name)
  })
})
