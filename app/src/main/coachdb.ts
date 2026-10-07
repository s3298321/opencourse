/**
 * Coach's half of the database: projects, sessions, turns and tool calls.
 *
 * The handle, the pragmas and the migrations live in db.ts, which is the only
 * file that touches `node:sqlite`'s own API. Everything here is a prepared
 * statement against the handle it hands back, bounded and filtered by project
 * or session - DatabaseSync is synchronous and blocks the main process, so
 * there is no unbounded SELECT anywhere below.
 */
import type { CoachProject, CoachSessionSummary, CoachToolRecord, TranscriptTurn } from '../core/types'
import { projectFromRow } from '../core/coach/projects'
import { db, tx } from './db'

/* --- projects -------------------------------------------------------------- */

export function insertProject(project: CoachProject): void {
  db()
    .prepare(
      `INSERT INTO projects (id, name, model, voice, instructions, allow_delete, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      project.id,
      project.name,
      project.model,
      project.voice,
      project.instructions,
      project.allowDelete ? 1 : 0,
      project.createdAt,
      project.updatedAt
    )
}

export function updateProjectRow(project: CoachProject): void {
  db()
    .prepare(
      `UPDATE projects SET name = ?, model = ?, voice = ?, instructions = ?, allow_delete = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      project.name,
      project.model,
      project.voice,
      project.instructions,
      project.allowDelete ? 1 : 0,
      project.updatedAt,
      project.id
    )
}

export function selectProject(id: string): CoachProject | null {
  const row = db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? projectFromRow(row) : null
}

export function selectProjects(): CoachProject[] {
  const rows = db().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Record<string, unknown>[]
  return rows.map(projectFromRow).filter((p): p is CoachProject => p !== null)
}

/** Sessions, turns and tool calls go with it - that is what the cascades are for. */
export function deleteProjectRow(id: string): void {
  db().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** One round trip for the list screen, rather than a query per card. */
export function sessionCounts(): Map<string, { sessions: number; lastSessionAt?: string }> {
  const rows = db()
    .prepare(
      `SELECT project_id, COUNT(*) AS n, MAX(started_at) AS last
       FROM sessions GROUP BY project_id`
    )
    .all() as { project_id: string; n: number; last: string | null }[]
  const out = new Map<string, { sessions: number; lastSessionAt?: string }>()
  for (const row of rows) {
    out.set(row.project_id, { sessions: Number(row.n), ...(row.last ? { lastSessionAt: row.last } : {}) })
  }
  return out
}

/* --- sessions -------------------------------------------------------------- */

export function insertSession(session: {
  id: string
  projectId: string
  startedAt: string
  model: string
  instructions: string
}): void {
  db()
    .prepare(
      `INSERT INTO sessions (id, project_id, started_at, status, model, instructions)
       VALUES (?, ?, ?, 'live', ?, ?)`
    )
    .run(session.id, session.projectId, session.startedAt, session.model, session.instructions)
}

export function finishSession(id: string, status: 'ended' | 'failed', error?: string): void {
  db()
    .prepare('UPDATE sessions SET status = ?, ended_at = ?, error = ? WHERE id = ?')
    .run(status, new Date().toISOString(), error ?? null, id)
}

export function selectSessionRow(
  id: string
): { id: string; project_id: string; status: string; instructions: string } | null {
  const row = db().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row
    ? {
        id: String(row['id']),
        project_id: String(row['project_id']),
        status: String(row['status']),
        instructions: String(row['instructions'])
      }
    : null
}

function sessionSummary(row: Record<string, unknown>, turns: number, title: string): CoachSessionSummary {
  const status = String(row['status'])
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    startedAt: String(row['started_at']),
    ...(row['ended_at'] ? { endedAt: String(row['ended_at']) } : {}),
    status: status === 'live' || status === 'failed' ? status : 'ended',
    model: String(row['model']),
    ...(row['error'] ? { error: String(row['error']) } : {}),
    turns,
    title
  }
}

export function selectSessions(projectId: string): CoachSessionSummary[] {
  const rows = db()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
              (SELECT t.text FROM turns t WHERE t.session_id = s.id AND t.role = 'user' ORDER BY t.seq LIMIT 1) AS opener
       FROM sessions s WHERE s.project_id = ? ORDER BY s.started_at DESC`
    )
    .all(projectId) as Record<string, unknown>[]
  return rows.map((row) =>
    sessionSummary(row, Number(row['turn_count'] ?? 0), typeof row['opener'] === 'string' ? row['opener'] : '')
  )
}

export function selectSessionSummary(id: string): CoachSessionSummary | null {
  const row = db()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
              (SELECT t.text FROM turns t WHERE t.session_id = s.id AND t.role = 'user' ORDER BY t.seq LIMIT 1) AS opener
       FROM sessions s WHERE s.id = ?`
    )
    .get(id) as Record<string, unknown> | undefined
  return row
    ? sessionSummary(row, Number(row['turn_count'] ?? 0), typeof row['opener'] === 'string' ? row['opener'] : '')
    : null
}

export function deleteSessionRow(id: string): void {
  db().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

/* --- turns and tool calls --------------------------------------------------- */

/**
 * Upsert, not insert: the renderer flushes turns on a timer and may re-send one
 * it is not sure landed. The (session_id, seq) primary key is what makes that
 * retry free.
 */
export function saveTurns(sessionId: string, turns: readonly TranscriptTurn[]): void {
  if (!turns.length) return
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO turns (session_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, text = excluded.text, at = excluded.at`
    )
    for (const turn of turns) stmt.run(sessionId, turn.seq, turn.role, turn.text, turn.at)
  })
}

export function selectTurns(sessionId: string): TranscriptTurn[] {
  const rows = db()
    .prepare('SELECT seq, role, text, at FROM turns WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Record<string, unknown>[]
  return rows.map((row) => ({
    seq: Number(row['seq']),
    role: row['role'] === 'user' || row['role'] === 'system' ? (row['role'] as 'user' | 'system') : 'assistant',
    text: String(row['text']),
    at: String(row['at'])
  }))
}

export function recordToolCall(sessionId: string, call: CoachToolRecord): void {
  db()
    .prepare(
      `INSERT INTO tool_calls (session_id, seq, call_id, name, arguments, result, ok, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, call.seq, call.callId, call.name, call.arguments, call.result ?? null, call.ok ? 1 : 0, call.at)
}

export function selectToolCalls(sessionId: string): CoachToolRecord[] {
  const rows = db()
    .prepare('SELECT seq, call_id, name, arguments, result, ok, at FROM tool_calls WHERE session_id = ? ORDER BY seq, id')
    .all(sessionId) as Record<string, unknown>[]
  return rows.map((row) => ({
    seq: Number(row['seq']),
    callId: String(row['call_id']),
    name: String(row['name']),
    arguments: String(row['arguments']),
    ...(row['result'] === null || row['result'] === undefined ? {} : { result: String(row['result']) }),
    ok: row['ok'] === 1,
    at: String(row['at'])
  }))
}
