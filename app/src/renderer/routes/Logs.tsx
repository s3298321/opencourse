import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import type { UserProfile } from '@core/types'
import { DEFAULT_LOG_QUERY, LOG_PAGE_SIZES, type LogOwner, type LogPage, type LogQuery, type LogRow, type LogSortColumn } from '@core/logging/query'
import { LOG_LEVELS, type LogLevel } from '@core/logging/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'

interface Props {
  user: UserProfile | null
  navigate: (r: Route, options?: { keepScroll?: boolean }) => void
  route: { name: 'logs'; from: Screen }
}

const SEARCH_DEBOUNCE_MS = 250

const COLUMNS: { id: LogSortColumn; label: string; className: string }[] = [
  { id: 'at', label: 'Time', className: 'logs-col-time' },
  { id: 'level', label: 'Level', className: 'logs-col-level' },
  { id: 'scope', label: 'Source', className: 'logs-col-scope' },
  { id: 'message', label: 'Message', className: 'logs-col-message' },
  { id: 'user', label: 'User', className: 'logs-col-user' }
]

const OWNERS: { id: LogOwner; label: string }[] = [
  { id: 'all', label: 'Mine + general' },
  { id: 'mine', label: 'Mine' },
  { id: 'general', label: 'General' }
]

const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error' }

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Local time to the millisecond: lines a few ms apart are the ones worth telling apart. */
function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** A `datetime-local` value as epoch ms; `end` takes the whole of that minute. */
function parseLocal(value: string, end: boolean): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms + (end ? 59_999 : 0) : null
}

function filtered(query: LogQuery): boolean {
  return Boolean(query.search || query.levels.length || query.scopes.length || query.from !== null || query.to !== null || query.owner !== 'all')
}

/**
 * The log, read-only: what the app did, newest first.
 *
 * You see your own lines and the general ones - startup, crashes, anything
 * written before a user was picked - and never another user's; main builds that
 * rule from the session, and this page only ever sends a filter. Every column
 * sorts, every filter goes back to page one, and a line opens to show the
 * details it was written with. Nothing here can write to the log or clear it.
 */
export default function Logs({ user, navigate, route }: Props): JSX.Element {
  const back = useCallback(() => navigate(route.from, { keepScroll: true }), [navigate, route.from])
  const [query, setQuery] = useState<LogQuery>(DEFAULT_LOG_QUERY)
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<LogPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [version, setVersion] = useState(0)
  const request = useRef(0)

  /** Any change to what is asked for starts again at page one. */
  const refine = useCallback((patch: Partial<LogQuery>) => setQuery((q) => ({ ...q, ...patch, page: 1 })), [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((q) => (q.search === search.trim() ? q : { ...q, search: search.trim(), page: 1 }))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!user) return
    // A slow answer to an old question must not overwrite a newer one.
    const mine = ++request.current
    setLoading(true)
    void window.opencourse
      .listLogs(query)
      .then((page) => {
        if (mine !== request.current) return
        setResult(page)
        setError(null)
        // The page served can be earlier than the one asked for, when a filter
        // left fewer pages; follow it so Next and Prev count from there.
        if (page.page !== query.page) setQuery((q) => ({ ...q, page: page.page }))
      })
      .catch((err: unknown) => {
        if (mine === request.current) setError((err as Error).message)
      })
      .finally(() => {
        if (mine === request.current) setLoading(false)
      })
  }, [query, version, user])

  useEffect(() => {
    if (!user) return
    void window.opencourse.listLogScopes().then(setScopes).catch(() => setScopes([]))
  }, [version, user])

  const refresh = (): void => setVersion((n) => n + 1)
  const reset = (): void => {
    setSearch('')
    setFrom('')
    setTo('')
    setExpanded(new Set())
    setQuery({ ...DEFAULT_LOG_QUERY, pageSize: query.pageSize })
  }

  const sortBy = (column: LogSortColumn): void => {
    setQuery((q) => ({
      ...q,
      page: 1,
      // A new column starts the way it reads best: time newest first, the rest A→Z or worst first.
      sort: q.sort.column === column
        ? { column, dir: q.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { column, dir: column === 'at' || column === 'level' ? 'desc' : 'asc' }
    }))
  }

  const toggleLevel = (level: LogLevel): void => {
    refine({ levels: query.levels.includes(level) ? query.levels.filter((l) => l !== level) : [...query.levels, level] })
  }

  const toggleRow = (id: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, id: number): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleRow(id)
    }
  }

  const total = result?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / query.pageSize))
  const first = total ? (query.page - 1) * query.pageSize + 1 : 0
  const last = Math.min(total, query.page * query.pageSize)
  const rows: LogRow[] = result?.rows ?? []

  return (
    <>
      <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Back', onClick: back }} />
      <div className="body">
        <div className="content scroll">
          <div className="logs">
            <h1>Logs</h1>
            <p className="meta">
              What the app did, newest first: your lines and the general ones written outside any user. Kept for
              30 days. Keys and the text of your conversations are never logged.
            </p>

            <div className="logs-toolbar" role="search">
              <input
                type="text"
                className="logs-search"
                placeholder="Search messages and details"
                aria-label="Search the log"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="logs-levels" role="group" aria-label="Levels">
                {LOG_LEVELS.map((level) => (
                  <button
                    key={level}
                    className={`logs-level-toggle level-${level}`}
                    data-level={level}
                    aria-pressed={query.levels.includes(level)}
                    onClick={() => toggleLevel(level)}
                  >
                    {LEVEL_LABEL[level]}
                  </button>
                ))}
              </div>
              <select
                className="logs-scope"
                aria-label="Source"
                value={query.scopes[0] ?? ''}
                onChange={(e) => refine({ scopes: e.target.value ? [e.target.value] : [] })}
              >
                <option value="">Every source</option>
                {scopes.map((scope) => (
                  <option key={scope} value={scope}>{scope}</option>
                ))}
              </select>
              <div className="logs-owner" role="radiogroup" aria-label="Whose lines">
                {OWNERS.map((owner) => (
                  <button
                    key={owner.id}
                    role="radio"
                    data-owner={owner.id}
                    aria-checked={query.owner === owner.id}
                    onClick={() => refine({ owner: owner.id })}
                  >
                    {owner.label}
                  </button>
                ))}
              </div>
              <div className="logs-ranges">
                <label className="logs-range">
                  From
                  <input
                    type="datetime-local"
                    className="logs-from"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value)
                      refine({ from: parseLocal(e.target.value, false) })
                    }}
                  />
                </label>
                <label className="logs-range">
                  To
                  <input
                    type="datetime-local"
                    className="logs-to"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value)
                      refine({ to: parseLocal(e.target.value, true) })
                    }}
                  />
                </label>
              </div>
              <div className="logs-actions">
                <button className="secondary logs-refresh" onClick={refresh} disabled={loading}>Refresh</button>
                <button className="ghost logs-reset" onClick={reset} disabled={!filtered(query) && !search}>Reset filters</button>
              </div>
            </div>

            {error && <p className="import-note error">{error}</p>}

            <table className="logs-table" aria-busy={loading}>
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const active = query.sort.column === column.id
                    return (
                      <th
                        key={column.id}
                        className={column.className}
                        aria-sort={active ? (query.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button className="logs-sort" data-column={column.id} onClick={() => sortBy(column.id)}>
                          {column.label}
                          <span className="logs-sort-arrow" aria-hidden="true">
                            {active ? (query.sort.dir === 'asc' ? '↑' : '↓') : ''}
                          </span>
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = expanded.has(row.id)
                  return [
                    <tr
                      key={row.id}
                      className={`logs-row level-${row.level}${open ? ' open' : ''}`}
                      data-at={row.at}
                      data-level={row.level}
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggleRow(row.id)}
                      onKeyDown={(e) => onRowKey(e, row.id)}
                    >
                      <td className="logs-col-time">{stamp(row.at)}</td>
                      <td className="logs-col-level"><span className={`logs-level level-${row.level}`}>{LEVEL_LABEL[row.level]}</span></td>
                      <td className="logs-col-scope">{row.scope}</td>
                      <td className="logs-col-message">{row.message}</td>
                      <td className="logs-col-user">{row.mine ? 'You' : 'General'}</td>
                    </tr>,
                    open && (
                      <tr key={`${row.id}-detail`} className="logs-detail">
                        <td colSpan={COLUMNS.length}>
                          <pre>{row.message}{row.data ? `\n\n${JSON.stringify(row.data, null, 2)}` : ''}</pre>
                        </td>
                      </tr>
                    )
                  ]
                })}
              </tbody>
            </table>

            {!loading && !error && rows.length === 0 && (
              <p className="logs-empty meta">
                {filtered(query) ? 'No log lines match these filters.' : 'Nothing has been logged yet.'}
              </p>
            )}

            <div className="logs-footer">
              <span className="logs-count meta">
                {total ? `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}` : loading ? 'Loading…' : '0 lines'}
              </span>
              <div className="logs-pager">
                <button className="secondary logs-prev" disabled={query.page <= 1 || loading} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}>
                  ← Previous
                </button>
                <span className="meta">Page {query.page} of {pages}</span>
                <button className="secondary logs-next" disabled={query.page >= pages || loading} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}>
                  Next →
                </button>
              </div>
              <label className="logs-page-size meta">
                Per page
                <select value={query.pageSize} onChange={(e) => refine({ pageSize: Number(e.target.value) })}>
                  {LOG_PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
