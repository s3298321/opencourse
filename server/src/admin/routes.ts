/**
 * The admin console's API. Every route needs an account with the admin role -
 * granted on the server's machine with `npm run admin -- grant-admin <name>`,
 * or by another admin here - and every change is written to the audit log.
 *
 *   GET  /admin/stats
 *   GET  /admin/accounts?q=&page=          POST /admin/accounts/:id/disable | enable
 *                                          PUT  /admin/accounts/:id/role {role}
 *   GET  /admin/courses?q=&state=&page=    POST /admin/courses/:id/moderate {reason} | restore
 *   GET  /admin/audit?q=&page=
 *
 * Moderation is not the owner's unlisting: it is its own column, a new publish
 * does not undo it, and the owner cannot relist over it (publish/publish.ts).
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AccountRole, AdminAccount, AdminCourse, AdminStats, Paged } from '@core/catalog/api'
import { nowIso, tx, type Db } from '../db'
import { badRequest, conflict, notFound } from '../errors'
import type { Ctx } from '../context'
import { audit, auditPage, AUDIT_PAGE_SIZE } from '../audit'
import { requireAdmin } from '../auth/routes'
import { revokeAccountSessions } from '../auth/sessions'
import { refreshListing } from '../catalog/catalog'

export const ADMIN_PAGE_SIZE = 25
const MAX_REASON = 500

const pageOf = (value: unknown): number => Math.max(1, Math.min(10_000, Math.floor(Number(value ?? 1)) || 1))
const likeOf = (q: string): string => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

function bytesUnder(dir: string): number {
  let total = 0
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return 0 }
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      const stat = statSync(path)
      total += stat.isDirectory() ? bytesUnder(path) : stat.size
    } catch { /* gone since the listing */ }
  }
  return total
}

export function adminStats(d: Db, dataDir: string): AdminStats {
  const count = (sql: string, ...params: string[]): number => Number((d.prepare(sql).get(...params) as { n: number }).n)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
  return {
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    disabledAccounts: count('SELECT COUNT(*) AS n FROM accounts WHERE disabled_at IS NOT NULL'),
    admins: count("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'"),
    courses: count('SELECT COUNT(*) AS n FROM courses'),
    listedCourses: count('SELECT COUNT(*) AS n FROM courses WHERE unlisted_at IS NULL AND moderated_at IS NULL AND current_version IS NOT NULL'),
    moderatedCourses: count('SELECT COUNT(*) AS n FROM courses WHERE moderated_at IS NOT NULL'),
    versions: count('SELECT COUNT(*) AS n FROM course_versions WHERE deleted_at IS NULL'),
    downloads30d: count("SELECT COUNT(DISTINCT course_id || ':' || account_id) AS n FROM acquisitions WHERE kind = 'add' AND at >= ?", since),
    storageBytes: bytesUnder(join(dataDir, 'archives')) + bytesUnder(join(dataDir, 'covers'))
  }
}

interface AccountRow { id: string; username: string; email: string; role: AccountRole; created_at: string; disabled_at: string | null; course_count: number; last_seen_at: string | null }
const accountOf = (r: AccountRow): AdminAccount => ({
  id: r.id, username: r.username, email: r.email, role: r.role, createdAt: r.created_at,
  disabledAt: r.disabled_at, courseCount: Number(r.course_count), lastSeenAt: r.last_seen_at
})
const SELECT_ACCOUNT = `SELECT a.id, a.username, a.email, a.role, a.created_at, a.disabled_at,
  (SELECT COUNT(*) FROM courses c WHERE c.owner_id = a.id) AS course_count,
  (SELECT MAX(s.last_used_at) FROM sessions s WHERE s.account_id = a.id) AS last_seen_at
  FROM accounts a`

export function adminAccounts(d: Db, q: string, page: number): Paged<AdminAccount> {
  const where = q ? "WHERE a.username LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR a.id = ?" : ''
  const params = q ? [likeOf(q), likeOf(q), q] : []
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM accounts a ${where}`).get(...params) as { n: number }).n)
  const rows = d.prepare(`${SELECT_ACCOUNT} ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE) as unknown as AccountRow[]
  return { items: rows.map(accountOf), total, page, pageSize: ADMIN_PAGE_SIZE }
}

function adminAccount(d: Db, id: string): AdminAccount | null {
  const row = d.prepare(`${SELECT_ACCOUNT} WHERE a.id = ?`).get(id) as AccountRow | undefined
  return row ? accountOf(row) : null
}

export type CourseState = 'listed' | 'unlisted' | 'moderated' | 'all'
interface CourseRow { id: string; publisher: string; current_version: string | null; unlisted_at: string | null; moderated_at: string | null; moderation_reason: string; updated_at: string; title: string | null; downloads: number }
const SELECT_COURSE = `SELECT c.id, a.username AS publisher, c.current_version, c.unlisted_at, c.moderated_at, c.moderation_reason, c.updated_at,
  COALESCE((SELECT json_extract(v.overview, '$.title') FROM course_versions v WHERE v.course_id = c.id AND v.version = c.current_version),
    (SELECT json_extract(v.overview, '$.title') FROM course_versions v WHERE v.course_id = c.id ORDER BY v.major DESC, v.minor DESC, v.patch DESC LIMIT 1)) AS title,
  (SELECT COUNT(DISTINCT q.account_id) FROM acquisitions q WHERE q.course_id = c.id AND q.kind = 'add') AS downloads
  FROM courses c JOIN accounts a ON a.id = c.owner_id`
const courseOf = (r: CourseRow): AdminCourse => ({
  id: r.id, title: r.title ?? '(untitled)', publisher: r.publisher, currentVersion: r.current_version,
  listed: r.unlisted_at === null && r.moderated_at === null && r.current_version !== null,
  unlistedAt: r.unlisted_at, moderation: r.moderated_at ? { at: r.moderated_at, reason: r.moderation_reason } : null,
  downloads: Number(r.downloads), updatedAt: r.updated_at
})

export function adminCourses(d: Db, q: string, state: CourseState, page: number): Paged<AdminCourse> {
  const where: string[] = []
  const params: string[] = []
  if (state === 'listed') where.push('c.unlisted_at IS NULL AND c.moderated_at IS NULL AND c.current_version IS NOT NULL')
  if (state === 'unlisted') where.push('c.moderated_at IS NULL AND (c.unlisted_at IS NOT NULL OR c.current_version IS NULL)')
  if (state === 'moderated') where.push('c.moderated_at IS NOT NULL')
  if (q) {
    where.push("(c.id = ? OR a.username LIKE ? ESCAPE '\\' OR c.id IN (SELECT course_id FROM course_versions WHERE json_extract(overview, '$.title') LIKE ? ESCAPE '\\'))")
    params.push(q, likeOf(q), likeOf(q))
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM courses c JOIN accounts a ON a.id = c.owner_id ${clause}`).get(...params) as { n: number }).n)
  const rows = d.prepare(`${SELECT_COURSE} ${clause} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`).all(...params, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE) as unknown as CourseRow[]
  return { items: rows.map(courseOf), total, page, pageSize: ADMIN_PAGE_SIZE }
}

function adminCourse(d: Db, id: string): AdminCourse | null {
  const row = d.prepare(`${SELECT_COURSE} WHERE c.id = ?`).get(id) as CourseRow | undefined
  return row ? courseOf(row) : null
}

/** Shared with the command line, which acts with `actor: null`. */
export function setDisabled(d: Db, actor: { id: string; username: string } | null, accountId: string, disabled: boolean): AdminAccount {
  const target = adminAccount(d, accountId)
  if (!target) throw notFound('There is no such account.')
  if (actor && actor.id === accountId) throw conflict('self', 'You cannot disable your own account.')
  if (disabled && target.role === 'admin' && activeAdmins(d) <= 1) throw conflict('last_admin', 'This is the only administrator.')
  tx(d, () => {
    d.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').run(disabled ? nowIso() : null, accountId)
    if (disabled) revokeAccountSessions(d, accountId)
    audit(d, { actor, action: disabled ? 'account.disable' : 'account.enable', targetKind: 'account', targetId: accountId, targetName: target.username })
  })
  return adminAccount(d, accountId)!
}

const activeAdmins = (d: Db): number => Number((d.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled_at IS NULL").get() as { n: number }).n)

export function setRole(d: Db, actor: { id: string; username: string } | null, accountId: string, role: AccountRole): AdminAccount {
  const target = adminAccount(d, accountId)
  if (!target) throw notFound('There is no such account.')
  if (target.role === role) return target
  if (actor && actor.id === accountId) throw conflict('self', 'Another administrator has to change your role.')
  if (role === 'member' && target.role === 'admin' && activeAdmins(d) <= 1) throw conflict('last_admin', 'This is the only administrator.')
  tx(d, () => {
    d.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, accountId)
    audit(d, { actor, action: role === 'admin' ? 'account.grant-admin' : 'account.revoke-admin', targetKind: 'account', targetId: accountId, targetName: target.username })
  })
  return adminAccount(d, accountId)!
}

export function setModerated(d: Db, actor: { id: string; username: string } | null, courseId: string, reason: string | null): AdminCourse {
  const target = adminCourse(d, courseId)
  if (!target) throw notFound('There is no such course.')
  tx(d, () => {
    d.prepare('UPDATE courses SET moderated_at = ?, moderation_reason = ? WHERE id = ?').run(reason === null ? null : nowIso(), reason ?? '', courseId)
    refreshListing(d, courseId)
    audit(d, { actor, action: reason === null ? 'course.restore' : 'course.moderate', targetKind: 'course', targetId: courseId, targetName: target.title, detail: reason ?? '' })
  })
  return adminCourse(d, courseId)!
}

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db: d, config, mailer } = ctx

  app.get('/api/v1/admin/stats', async (request) => {
    requireAdmin(request)
    return adminStats(d, config.dataDir)
  })

  app.get('/api/v1/admin/accounts', async (request) => {
    requireAdmin(request)
    const query = request.query as Record<string, unknown>
    return adminAccounts(d, text(query['q']), pageOf(query['page']))
  })

  app.post('/api/v1/admin/accounts/:id/disable', async (request) => setDisabled(d, requireAdmin(request), (request.params as { id: string }).id, true))
  app.post('/api/v1/admin/accounts/:id/enable', async (request) => setDisabled(d, requireAdmin(request), (request.params as { id: string }).id, false))

  app.put('/api/v1/admin/accounts/:id/role', {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: ['member', 'admin'] } } } }
  }, async (request) => setRole(d, requireAdmin(request), (request.params as { id: string }).id, (request.body as { role: AccountRole }).role))

  app.get('/api/v1/admin/courses', async (request) => {
    requireAdmin(request)
    const query = request.query as Record<string, unknown>
    const state = (['listed', 'unlisted', 'moderated'] as const).find((s) => s === query['state']) ?? 'all'
    return adminCourses(d, text(query['q']), state, pageOf(query['page']))
  })

  app.post('/api/v1/admin/courses/:id/moderate', {
    schema: { body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: MAX_REASON } } } }
  }, async (request) => {
    const actor = requireAdmin(request)
    const reason = (request.body as { reason: string }).reason.trim()
    if (!reason) throw badRequest('reason_required', 'Say why, so the publisher knows what to change.')
    const course = setModerated(d, actor, (request.params as { id: string }).id, reason)
    const owner = d.prepare('SELECT a.email, a.username FROM courses c JOIN accounts a ON a.id = c.owner_id WHERE c.id = ?').get(course.id) as { email: string; username: string }
    await mailer.send({ to: owner.email, subject: `"${course.title}" was removed from ${config.name}`, text: `A moderator of ${config.name} (${config.publicUrl}) removed your course "${course.title}" from the catalog:\n\n    ${reason}\n\nLearners who already added it keep their copy. Reply to the people who run ${config.name} if you think this was a mistake.` })
    return course
  })

  app.post('/api/v1/admin/courses/:id/restore', async (request) => setModerated(d, requireAdmin(request), (request.params as { id: string }).id, null))

  app.get('/api/v1/admin/audit', async (request) => {
    requireAdmin(request)
    const query = request.query as Record<string, unknown>
    const page = pageOf(query['page'])
    return { ...auditPage(d, page, text(query['q'])), page, pageSize: AUDIT_PAGE_SIZE }
  })
}
