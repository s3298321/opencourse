/**
 * The Logs page's query, at the IPC boundary and as SQL. The owner clause is
 * the rule that matters: a user reads their lines and the general ones, never
 * another user's, whatever the renderer sends.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOG_QUERY, buildLogSql, escapeLike, normalizeLogQuery, ownerClause } from '../src/core/logging/query'

describe('normalizeLogQuery', () => {
  it('defaults to newest first, page one, fifty a page, everyone allowed', () => {
    expect(normalizeLogQuery(undefined)).toEqual(DEFAULT_LOG_QUERY)
    expect(normalizeLogQuery('nonsense')).toEqual(DEFAULT_LOG_QUERY)
    expect(DEFAULT_LOG_QUERY.sort).toEqual({ column: 'at', dir: 'desc' })
  })

  it('refuses a sort column it does not know, rather than splicing it into SQL', () => {
    const q = normalizeLogQuery({ sort: { column: 'id; DROP TABLE logs', dir: 'asc' } })
    expect(q.sort).toEqual({ column: 'at', dir: 'asc' })
    expect(normalizeLogQuery({ sort: { column: 'level', dir: 'sideways' } }).sort).toEqual({ column: 'level', dir: 'asc' })
  })

  it('clamps paging', () => {
    expect(normalizeLogQuery({ page: -4, pageSize: 100_000 })).toMatchObject({ page: 1, pageSize: 200 })
    expect(normalizeLogQuery({ page: 3.7, pageSize: 1 })).toMatchObject({ page: 3, pageSize: 10 })
    expect(normalizeLogQuery({ page: 'x', pageSize: '25' })).toMatchObject({ page: 1, pageSize: 25 })
  })

  it('keeps only real levels and sane scopes, once each', () => {
    const q = normalizeLogQuery({ levels: ['error', 'error', 'fatal', 3], scopes: ['openai', '', 'openai', 'x'.repeat(101), 7] })
    expect(q.levels).toEqual(['error'])
    expect(q.scopes).toEqual(['openai'])
  })

  it('trims the search and bounds it, and accepts only real times', () => {
    const q = normalizeLogQuery({ search: `  ${'a'.repeat(500)}  `, from: 1000.9, to: -5 })
    expect(q.search).toHaveLength(200)
    expect(q.from).toBe(1000)
    expect(q.to).toBeNull()
  })

  it('falls back to mine-plus-general for an owner it does not know - there is no "everyone"', () => {
    expect(normalizeLogQuery({ owner: 'everyone' }).owner).toBe('all')
    expect(normalizeLogQuery({ owner: 'general' }).owner).toBe('general')
  })
})

describe('buildLogSql', () => {
  it('names only this user, or no user, in every owner clause', () => {
    expect(ownerClause('mine', 'u_a')).toEqual({ sql: 'user_id = ?', params: ['u_a'] })
    expect(ownerClause('general', 'u_a')).toEqual({ sql: 'user_id IS NULL', params: [] })
    expect(ownerClause('all', 'u_a')).toEqual({ sql: '(user_id = ? OR user_id IS NULL)', params: ['u_a'] })
    const sql = buildLogSql(DEFAULT_LOG_QUERY, 'u_a')
    expect(sql.where).toBe('(user_id = ? OR user_id IS NULL)')
    expect(sql.params).toEqual(['u_a'])
  })

  it('binds every filter as a parameter, in order', () => {
    const q = normalizeLogQuery({ levels: ['warn', 'error'], scopes: ['openai'], search: '50%_off', from: 10, to: 20, owner: 'mine', page: 3, pageSize: 25 })
    const sql = buildLogSql(q, 'u_a')
    expect(sql.where).toBe(
      "user_id = ? AND level IN (?, ?) AND scope IN (?) AND (message LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\') AND at >= ? AND at <= ?"
    )
    expect(sql.params).toEqual(['u_a', 30, 40, 'openai', '%50\\%\\_off%', '%50\\%\\_off%', '%50\\%\\_off%', 10, 20])
    expect(sql.limit).toBe(25)
    expect(sql.offset).toBe(50)
  })

  it('sorts by the column asked for, newest first within it, id last', () => {
    expect(buildLogSql(DEFAULT_LOG_QUERY, 'u').orderBy).toBe('at DESC, id DESC')
    expect(buildLogSql(normalizeLogQuery({ sort: { column: 'at', dir: 'asc' } }), 'u').orderBy).toBe('at ASC, id ASC')
    expect(buildLogSql(normalizeLogQuery({ sort: { column: 'level', dir: 'desc' } }), 'u').orderBy).toBe('level DESC, at DESC, id DESC')
    expect(buildLogSql(normalizeLogQuery({ sort: { column: 'user', dir: 'asc' } }), 'u').orderBy).toBe('(user_id IS NULL) ASC, at DESC, id DESC')
  })

  it('escapes the characters LIKE treats as wildcards', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\')
  })
})
