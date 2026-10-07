import type { DatabaseSync } from 'node:sqlite'
import type { AIProvider, ChatMessage, ProjectChatSummary, ReasoningEffort } from '../core/types'
import { registeredCourse, registeredElement } from './course-registry'
import { db } from './db'
interface Row { id: string; course_slug: string; module_slug: string; model: string; provider: AIProvider; reasoning: ReasoningEffort | null; created_at: string; updated_at: string; title: string; messages: number }
const SUMMARY = `SELECT c.*, COALESCE(c.generated_title, (SELECT text FROM course_project_messages WHERE chat_id = c.id AND role = 'user' ORDER BY seq LIMIT 1), '') AS title, (SELECT COUNT(*) FROM course_project_messages WHERE chat_id = c.id AND role != 'context') AS messages FROM course_project_chats c`
function summary(row: Row): ProjectChatSummary {
  return { id: row.id, courseId: row.course_slug, moduleId: row.module_slug, model: row.model, provider: row.provider === 'chatgpt' ? 'chatgpt' : 'apiKey', reasoning: row.reasoning, createdAt: row.created_at, updatedAt: row.updated_at, title: row.title.slice(0, 120), messages: row.messages, historyLabel: 'Project conversation' }
}
export function selectProjectChats(courseId: string, moduleId: string): ProjectChatSummary[] {
  return (db().prepare(`${SUMMARY} WHERE c.course_slug = ? AND c.module_slug = ? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 200`).all(courseId, moduleId) as unknown as Row[]).map(summary)
}
export function selectProjectChat(id: string, d = db()): ProjectChatSummary | null {
  const row = d.prepare(`${SUMMARY} WHERE c.id = ?`).get(id) as unknown as Row | undefined
  return row ? summary(row) : null
}
export function insertProjectChat(chat: Omit<ProjectChatSummary, 'title' | 'messages'>): void {
  db().prepare('INSERT INTO course_project_chats (id, course_slug, module_slug, model, reasoning, created_at, updated_at, provider, course_id, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(chat.id, chat.courseId, chat.moduleId, chat.model, chat.reasoning, chat.createdAt, chat.updatedAt, chat.provider ?? 'apiKey', registeredCourse(db(), chat.courseId), registeredElement(db(), chat.courseId, chat.moduleId))
}
export function selectProjectMessages(id: string, d = db()): ChatMessage[] {
  return (d.prepare('SELECT payload FROM course_project_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 400').all(id) as { payload: string }[]).reverse().map((r) => JSON.parse(r.payload) as ChatMessage)
}
export function appendProjectMessage(id: string, message: Omit<ChatMessage, 'seq'>, d = db()): number {
  const row = d.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM course_project_messages WHERE chat_id = ?').get(id) as { seq: number }
  d.prepare('INSERT INTO course_project_messages (chat_id, seq, role, text, payload) VALUES (?, ?, ?, ?, ?)').run(id, row.seq, message.role, message.text, JSON.stringify({ ...message, seq: row.seq }))
  d.prepare('UPDATE course_project_chats SET updated_at = ? WHERE id = ?').run(message.at, id)
  return row.seq
}
export function updateProjectChat(id: string, model: string, reasoning: ReasoningEffort | null, provider?: AIProvider): void {
  db().prepare('UPDATE course_project_chats SET model = ?, reasoning = ?, provider = COALESCE(?, provider), updated_at = ? WHERE id = ?').run(model, reasoning, provider ?? null, new Date().toISOString(), id)
}
export function deleteProjectChatRow(id: string): void { db().prepare('DELETE FROM course_project_chats WHERE id = ?').run(id) }
export function recordProjectTool(d: DatabaseSync, id: string, seq: number, callId: string, name: string, args: unknown, result: string): void {
  d.prepare('INSERT OR IGNORE INTO course_project_tool_calls (chat_id, message_seq, call_id, name, arguments, result, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, seq, callId, name, JSON.stringify(args), result.length > 80000 ? JSON.stringify({ truncated: true, excerpt: result.slice(0, 80000) }) : result, new Date().toISOString())
}
