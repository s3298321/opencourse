/**
 * The audit log: who did what to whom, for every administrative action and the
 * security events an account owner or a moderator may need to look back at.
 * Metadata only - names and ids, never a password, a code or a token. Names
 * are copied in, so an entry still reads after its account is deleted.
 */
import type { AuditEntry } from '@core/catalog/api'
import { nowIso, type Db } from './db'

export interface AuditEvent {
  /** Null for the command line, which acts as nobody in particular. */
  actor: { id: string; username: string } | null
  action: string
  targetKind?: string
  targetId?: string
  targetName?: string
  detail?: string
}

export function audit(d: Db, event: AuditEvent): void {
  d.prepare('INSERT INTO audit_log(at, actor_id, actor_name, action, target_kind, target_id, target_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), event.actor?.id ?? null, event.actor?.username ?? 'command line', event.action, event.targetKind ?? '', event.targetId ?? '', event.targetName ?? '', (event.detail ?? '').slice(0, 500))
}

export const AUDIT_PAGE_SIZE = 50

export function auditPage(d: Db, page: number, q = ''): { items: AuditEntry[]; total: number } {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const where = q ? "WHERE actor_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR target_id = ?" : ''
  const params = q ? [like, like, like, q] : []
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }).n)
  const rows = d.prepare(`SELECT id, at, actor_name, action, target_kind, target_id, target_name, detail FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE) as { id: number; at: string; actor_name: string; action: string; target_kind: string; target_id: string; target_name: string; detail: string }[]
  return {
    total,
    items: rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor_name, action: r.action, targetKind: r.target_kind, targetId: r.target_id, targetName: r.target_name, detail: r.detail }))
  }
}
