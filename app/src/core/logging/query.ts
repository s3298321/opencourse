/**
 * What the Logs page may ask for, and the SQL that answers it.
 *
 * Pure, so the rule that matters most is a unit test: **a user reads their own
 * lines and the general ones, never another user's.** The owner clause is
 * built here from the user main supplies - the renderer sends a filter, never
 * an id - and every shape of it names that one user or `user_id IS NULL`.
 *
 * `normalizeLogQuery` is the IPC boundary. Sort columns come from a whitelist
 * and are mapped to fixed SQL, so nothing the renderer sends is ever spliced
 * into a statement; everything else is a bound parameter.
 */
import { LEVEL_RANK, isLogLevel, type LogLevel } from './types'

export type LogSortColumn = 'at' | 'level' | 'scope' | 'message' | 'user'
export type LogOwner = 'all' | 'mine' | 'general'

export interface LogQuery {
  /** 1-based. */
  page: number
  pageSize: number
  sort: { column: LogSortColumn; dir: 'asc' | 'desc' }
  /** Empty means every level. */
  levels: LogLevel[]
  /** Empty means every scope. */
  scopes: string[]
  search: string
  /** Epoch ms, inclusive. */
  from: number | null
  to: number | null
  owner: LogOwner
}

export interface LogRow {
  id: number
  at: number
  level: LogLevel
  scope: string
  message: string
  /** Written while this user was selected; false is a general line. */
  mine: boolean
  data: Record<string, unknown> | null
}

export interface LogPage {
  rows: LogRow[]
  total: number
  /** The page actually served - clamped when a filter left fewer pages than asked for. */
  page: number
  query: LogQuery
}

export const LOG_PAGE_SIZES = [25, 50, 100] as const
const MIN_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 200
const MAX_SEARCH = 200
const MAX_SCOPES = 50

export const DEFAULT_LOG_QUERY: LogQuery = {
  page: 1,
  pageSize: 50,
  sort: { column: 'at', dir: 'desc' },
  levels: [],
  scopes: [],
  search: '',
  from: null,
  to: null,
  owner: 'all'
}

const SORT_SQL: Record<LogSortColumn, string> = {
  at: 'at',
  level: 'level',
  scope: 'scope COLLATE NOCASE',
  message: 'message COLLATE NOCASE',
  // 0 for a line of yours, 1 for a general one: ascending puts yours first.
  user: '(user_id IS NULL)'
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

/** Whatever crossed IPC, as a query that is safe to run. Never throws. */
export function normalizeLogQuery(raw: unknown): LogQuery {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sort = (input['sort'] && typeof input['sort'] === 'object' ? input['sort'] : {}) as Record<string, unknown>
  const column = typeof sort['column'] === 'string' && sort['column'] in SORT_SQL ? (sort['column'] as LogSortColumn) : DEFAULT_LOG_QUERY.sort.column
  const dir = sort['dir'] === 'asc' || sort['dir'] === 'desc' ? sort['dir'] : column === 'at' ? 'desc' : 'asc'
  const levels = Array.isArray(input['levels']) ? [...new Set(input['levels'].filter(isLogLevel))] : []
  const scopes = Array.isArray(input['scopes'])
    ? [...new Set(input['scopes'].filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 100))].slice(0, MAX_SCOPES)
    : []
  const owner = input['owner'] === 'mine' || input['owner'] === 'general' ? input['owner'] : 'all'
  return {
    page: int(input['page'], 1, 1, 1_000_000),
    pageSize: int(input['pageSize'], DEFAULT_LOG_QUERY.pageSize, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
    sort: { column, dir },
    levels,
    scopes,
    search: typeof input['search'] === 'string' ? input['search'].trim().slice(0, MAX_SEARCH) : '',
    from: time(input['from']),
    to: time(input['to']),
    owner
  }
}

/** `%` and `_` mean themselves in a search box. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export interface LogSql {
  where: string
  params: (string | number)[]
  orderBy: string
  limit: number
  offset: number
}

/** The owner clause alone - the part every statement against the table must carry. */
export function ownerClause(owner: LogOwner, userId: string): { sql: string; params: string[] } {
  if (owner === 'mine') return { sql: 'user_id = ?', params: [userId] }
  if (owner === 'general') return { sql: 'user_id IS NULL', params: [] }
  return { sql: '(user_id = ? OR user_id IS NULL)', params: [userId] }
}

export function buildLogSql(query: LogQuery, userId: string): LogSql {
  const owner = ownerClause(query.owner, userId)
  const clauses = [owner.sql]
  const params: (string | number)[] = [...owner.params]

  if (query.levels.length) {
    clauses.push(`level IN (${query.levels.map(() => '?').join(', ')})`)
    params.push(...query.levels.map((level) => LEVEL_RANK[level]))
  }
  if (query.scopes.length) {
    clauses.push(`scope IN (${query.scopes.map(() => '?').join(', ')})`)
    params.push(...query.scopes)
  }
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`
    clauses.push("(message LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')")
    params.push(pattern, pattern, pattern)
  }
  if (query.from !== null) {
    clauses.push('at >= ?')
    params.push(query.from)
  }
  if (query.to !== null) {
    clauses.push('at <= ?')
    params.push(query.to)
  }

  const dir = query.sort.dir === 'asc' ? 'ASC' : 'DESC'
  // Ties fall back to newest first, and id breaks ties between lines written in
  // the same millisecond - insertion order is the order they happened in.
  const orderBy = query.sort.column === 'at'
    ? `at ${dir}, id ${dir}`
    : `${SORT_SQL[query.sort.column]} ${dir}, at DESC, id DESC`

  return {
    where: clauses.join(' AND '),
    params,
    orderBy,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize
  }
}
