import { useEffect, useState } from 'react'
import { Form, Link, NavLink, Outlet, useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router'
import { ArrowUpRight, Ban, BookOpen, CheckCircle2, HardDrive, History, MoreHorizontal, RotateCcw, Search, ShieldAlert, ShieldCheck, ShieldOff, Users } from 'lucide-react'
import type { AdminAccount, AdminCourse, AdminStats, AuditEntry, Paged } from '@core/catalog/api'
import { api, ApiError } from '../../lib/api'
import { server } from '../../lib/boot'
import { requireAdmin, signedIn } from '../../lib/guards'
import { useAccount } from '../../lib/session'
import { ago, bytes, compact, date, dateTime, plural } from '../../lib/format'
import { Avatar } from '../../components/Layout'
import { Menu } from '../../components/Menu'
import { Dialog } from '../../components/Dialog'
import { EmptyState, PageHeader, Pager, useTitle } from '../../components/Bits'
import { useToast } from '../../components/Toasts'

const pageOf = (url: URL): number => Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
const message = (error: unknown): string => (error instanceof ApiError ? error.message : 'That did not work. Try again.')

export function AdminLayout() {
  return (
    <div className="oc-wrap page">
      <PageHeader eyebrow={<><ShieldCheck aria-hidden /> {server.name}</>} title="Administration" />
      <nav className="oc-segment admin-tabs" aria-label="Administration">
        <NavLink to="/admin" end viewTransition>Overview</NavLink>
        <NavLink to="/admin/accounts" viewTransition>Accounts</NavLink>
        <NavLink to="/admin/courses" viewTransition>Courses</NavLink>
        <NavLink to="/admin/audit" viewTransition>Audit log</NavLink>
      </nav>
      <Outlet />
    </div>
  )
}

/* ---------- overview ---------- */

export async function adminStatsLoader({ request }: LoaderFunctionArgs): Promise<{ stats: AdminStats; recent: AuditEntry[] }> {
  requireAdmin(request)
  return signedIn(request, async () => {
    const [stats, audit] = await Promise.all([api.admin.stats(), api.admin.audit('', 1)])
    return { stats, recent: audit.items.slice(0, 8) }
  })
}

export function AdminOverview() {
  const { stats, recent } = useLoaderData() as { stats: AdminStats; recent: AuditEntry[] }
  useTitle('Administration')
  const tiles = [
    { icon: <Users />, value: compact(stats.accounts), label: plural(stats.accounts, 'account').replace(/^[\d,.]+ /, ''), sub: `${stats.admins} admin${stats.admins === 1 ? '' : 's'} · ${stats.disabledAccounts} disabled`, to: '/admin/accounts' },
    { icon: <BookOpen />, value: compact(stats.courses), label: stats.courses === 1 ? 'course' : 'courses', sub: `${stats.listedCourses} listed · ${stats.moderatedCourses} moderated`, to: '/admin/courses' },
    { icon: <History />, value: compact(stats.versions), label: stats.versions === 1 ? 'version' : 'versions', sub: 'kept on disk', to: '/admin/courses' },
    { icon: <ArrowUpRight />, value: compact(stats.downloads30d), label: 'adds', sub: 'in the last 30 days', to: '/admin/courses' },
    { icon: <HardDrive />, value: bytes(stats.storageBytes), label: 'stored', sub: 'archives and covers', to: '/admin/courses' }
  ]
  return (
    <div className="stat-tiles oc-stagger">
      {tiles.map((tile) => (
        <Link key={tile.label} to={tile.to} className="stat-tile oc-card oc-glow" data-glow viewTransition>
          <span className="stat-tile-icon" aria-hidden="true">{tile.icon}</span>
          <span className="stat-tile-value">{tile.value}</span>
          <span className="stat-tile-label">{tile.label}</span>
          <span className="stat-tile-sub">{tile.sub}</span>
        </Link>
      ))}
      <section className="admin-recent oc-panel">
        <div className="section-head"><h2>Recent activity</h2><Link to="/admin/audit" className="how-link" viewTransition>Audit log<ArrowUpRight aria-hidden /></Link></div>
        {recent.length === 0 ? <p className="muted">Nothing yet. Administrative actions and account security events appear here.</p> : <AuditRows items={recent} />}
      </section>
    </div>
  )
}

function SearchBar({ placeholder, children }: { placeholder: string; children?: React.ReactNode }) {
  const [params] = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')
  useEffect(() => setValue(params.get('q') ?? ''), [params])
  return (
    <Form method="get" className="admin-search" role="search">
      <div className="admin-search-field"><Search aria-hidden /><input data-search type="search" name="q" className="oc-input" placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => setValue(e.target.value)} /></div>
      {children}
      <button type="submit" className="oc-btn secondary">Search</button>
    </Form>
  )
}

const pageHref = (params: URLSearchParams, page: number): string => {
  const next = new URLSearchParams(params)
  if (page > 1) next.set('page', String(page)); else next.delete('page')
  const text = next.toString()
  return text ? `?${text}` : '.'
}

/* ---------- accounts ---------- */

export async function adminAccountsLoader({ request }: LoaderFunctionArgs): Promise<Paged<AdminAccount>> {
  requireAdmin(request)
  const url = new URL(request.url)
  return signedIn(request, () => api.admin.accounts(url.searchParams.get('q') ?? '', pageOf(url)))
}

export function AdminAccounts() {
  const data = useLoaderData() as Paged<AdminAccount>
  const [params] = useSearchParams()
  const me = useAccount()
  const revalidator = useRevalidator()
  const notify = useToast()
  useTitle('Accounts · Administration')
  const act = async (work: () => Promise<AdminAccount>, done: (a: AdminAccount) => string): Promise<void> => {
    try { const account = await work(); notify(done(account)); revalidator.revalidate() } catch (error) { notify(message(error), 'err') }
  }
  return (
    <section className="admin-section oc-enter">
      <SearchBar placeholder="Search by name, email or id" />
      <p className="muted small">{plural(data.total, 'account')}</p>
      {data.items.length === 0 ? <EmptyState title="No accounts match" /> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Account</th><th>Role</th><th>Courses</th><th>Last seen</th><th>Joined</th><th><span className="oc-visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} className={a.disabledAt ? 'disabled' : ''}>
                  <td><div className="cell-account"><Avatar name={a.username} /><div><strong>{a.username}{a.id === me?.id && <span className="muted"> (you)</span>}</strong><span className="muted">{a.email}</span></div></div></td>
                  <td>{a.disabledAt ? <span className="oc-pill err"><span className="dot" />Disabled</span> : a.role === 'admin' ? <span className="oc-pill silver">Admin</span> : <span className="oc-pill">Member</span>}</td>
                  <td>{a.courseCount}</td>
                  <td>{a.lastSeenAt ? ago(a.lastSeenAt) : <span className="muted">–</span>}</td>
                  <td>{date(a.createdAt)}</td>
                  <td className="cell-actions">
                    {a.id !== me?.id && (
                      <Menu
                        label={`Actions for ${a.username}`}
                        items={[
                          a.disabledAt
                            ? { key: 'enable', label: 'Enable account', icon: <CheckCircle2 aria-hidden />, onSelect: () => { void act(() => api.admin.enable(a.id), (x) => `${x.username} can sign in again.`) } }
                            : { key: 'disable', label: 'Disable account', icon: <Ban aria-hidden />, tone: 'danger', onSelect: () => { void act(() => api.admin.disable(a.id), (x) => `${x.username} is disabled and signed out everywhere.`) } },
                          a.role === 'admin'
                            ? { key: 'member', label: 'Remove admin role', icon: <ShieldOff aria-hidden />, onSelect: () => { void act(() => api.admin.setRole(a.id, 'member'), (x) => `${x.username} is no longer an administrator.`) } }
                            : { key: 'admin', label: 'Make administrator', icon: <ShieldCheck aria-hidden />, onSelect: () => { void act(() => api.admin.setRole(a.id, 'admin'), (x) => `${x.username} is now an administrator.`) } }
                        ]}
                        trigger={({ open, toggle, ref }) => <button ref={ref} type="button" className="oc-btn ghost icon" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${a.username}`} onClick={toggle}><MoreHorizontal aria-hidden /></button>}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} href={(n) => pageHref(params, n)} />
    </section>
  )
}

/* ---------- courses ---------- */

export async function adminCoursesLoader({ request }: LoaderFunctionArgs): Promise<Paged<AdminCourse>> {
  requireAdmin(request)
  const url = new URL(request.url)
  return signedIn(request, () => api.admin.courses(url.searchParams.get('q') ?? '', url.searchParams.get('state') ?? '', pageOf(url)))
}

const STATES = [['', 'All'], ['listed', 'Listed'], ['unlisted', 'Unlisted'], ['moderated', 'Moderated']] as const

export function AdminCourses() {
  const data = useLoaderData() as Paged<AdminCourse>
  const [params] = useSearchParams()
  const revalidator = useRevalidator()
  const notify = useToast()
  const [moderating, setModerating] = useState<AdminCourse | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useTitle('Courses · Administration')
  const state = params.get('state') ?? ''
  const stateHref = (value: string): string => {
    const next = new URLSearchParams(params)
    next.delete('page')
    if (value) next.set('state', value); else next.delete('state')
    const text = next.toString()
    return text ? `?${text}` : '.'
  }
  const restore = async (course: AdminCourse): Promise<void> => {
    try { await api.admin.restore(course.id); notify(`“${course.title}” is back in the catalog.`); revalidator.revalidate() } catch (error) { notify(message(error), 'err') }
  }
  return (
    <section className="admin-section oc-enter">
      <SearchBar placeholder="Search by title, publisher or id">{state && <input type="hidden" name="state" value={state} />}</SearchBar>
      <div className="admin-filter">
        <div className="oc-segment" role="group" aria-label="Show">
          {STATES.map(([value, label]) => <Link key={value} to={stateHref(value)} aria-current={state === value ? 'page' : undefined}>{label}</Link>)}
        </div>
        <span className="muted small">{plural(data.total, 'course')}</span>
      </div>
      {data.items.length === 0 ? <EmptyState title="No courses match" /> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Course</th><th>Status</th><th>Version</th><th>Learners</th><th>Updated</th><th><span className="oc-visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td><div className="cell-course"><strong>{c.title}</strong><span className="muted">by {c.publisher}</span>{c.moderation && <span className="cell-reason"><ShieldAlert aria-hidden />{c.moderation.reason}</span>}</div></td>
                  <td>{c.moderation ? <span className="oc-pill err"><span className="dot" />Moderated</span> : c.listed ? <span className="oc-pill ok"><span className="dot" />Listed</span> : <span className="oc-pill"><span className="dot" />Unlisted</span>}</td>
                  <td>{c.currentVersion ?? <span className="muted">–</span>}</td>
                  <td>{compact(c.downloads)}</td>
                  <td>{ago(c.updatedAt)}</td>
                  <td className="cell-actions">
                    {c.moderation
                      ? <button type="button" className="oc-btn secondary sm" onClick={() => { void restore(c) }}><RotateCcw aria-hidden />Restore</button>
                      : <button type="button" className="oc-btn ghost sm danger-text" onClick={() => { setModerating(c); setReason('') }}><ShieldAlert aria-hidden />Remove</button>}
                    {c.listed && <Link className="oc-btn ghost icon" to={`/courses/${encodeURIComponent(c.id)}`} aria-label={`Open ${c.title}`}><ArrowUpRight aria-hidden /></Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} href={(n) => pageHref(params, n)} />
      <Dialog
        open={moderating !== null}
        onClose={() => setModerating(null)}
        tone="danger"
        title={`Remove “${moderating?.title ?? ''}” from the catalog?`}
        description={<>It disappears from the catalog for everyone but its publisher, <strong>{moderating?.publisher}</strong>, who is mailed your reason. A new version does not bring it back; only you or another administrator can.</>}
        onSubmit={() => {
          if (!moderating) return
          setBusy(true)
          api.admin.moderate(moderating.id, reason.trim())
            .then((course) => { notify(`“${course.title}” was removed from the catalog.`); setModerating(null); revalidator.revalidate() })
            .catch((error: unknown) => notify(message(error), 'err'))
            .finally(() => setBusy(false))
        }}
        footer={<><button type="button" className="oc-btn secondary" onClick={() => setModerating(null)}>Cancel</button><button type="submit" className="oc-btn danger-solid" disabled={busy || !reason.trim()}>Remove from catalog</button></>}
      >
        <div className="oc-field">
          <label className="oc-label" htmlFor="moderation-reason">Reason, for the publisher</label>
          <textarea id="moderation-reason" className="oc-textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong, and what would make it acceptable." />
          <span className="oc-hint">{reason.length}/500</span>
        </div>
      </Dialog>
    </section>
  )
}

/* ---------- audit log ---------- */

export async function adminAuditLoader({ request }: LoaderFunctionArgs): Promise<Paged<AuditEntry>> {
  requireAdmin(request)
  const url = new URL(request.url)
  return signedIn(request, () => api.admin.audit(url.searchParams.get('q') ?? '', pageOf(url)))
}

const ACTIONS: Record<string, string> = {
  'account.disable': 'disabled', 'account.enable': 'enabled', 'account.grant-admin': 'made an administrator:',
  'account.revoke-admin': 'removed the admin role from', 'account.delete': 'deleted the account', 'course.moderate': 'removed from the catalog',
  'course.restore': 'restored to the catalog', 'password.change': 'changed the password of', 'password.reset': 'reset the password of',
  'email.change': 'changed the email of', 'sessions.revoke-others': 'signed out the other sessions of'
}

function AuditRows({ items }: { items: AuditEntry[] }) {
  return (
    <ol className="audit-list">
      {items.map((e) => (
        <li key={e.id} className="audit-row">
          <time dateTime={e.at} title={dateTime(e.at)}>{ago(e.at)}</time>
          <p><strong>{e.actor}</strong> {ACTIONS[e.action] ?? e.action} <strong>{e.targetName || e.targetId}</strong>{e.detail && <span className="audit-detail"> - {e.detail}</span>}</p>
          <code className="audit-action">{e.action}</code>
        </li>
      ))}
    </ol>
  )
}

export function AdminAudit() {
  const data = useLoaderData() as Paged<AuditEntry>
  const [params] = useSearchParams()
  useTitle('Audit log · Administration')
  return (
    <section className="admin-section oc-enter">
      <SearchBar placeholder="Search by who, what or target" />
      {data.items.length === 0 ? <EmptyState title="Nothing logged yet">Administrative actions and account security events appear here.</EmptyState> : <AuditRows items={data.items} />}
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} href={(n) => pageHref(params, n)} />
    </section>
  )
}
