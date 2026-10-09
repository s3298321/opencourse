import type { DatabaseSync } from 'node:sqlite'
import type { AIProvider, ChatMessage, ChatSummary, ReasoningEffort } from '../core/types'
import { db } from './db'
import { isAIProvider } from '../core/ai'
const SUMMARY = `SELECT c.*, COALESCE(c.generated_title, (SELECT text FROM authoring_messages WHERE chat_id=c.id AND role='user' ORDER BY seq LIMIT 1), '') AS title, (SELECT COUNT(*) FROM authoring_messages WHERE chat_id=c.id AND role!='context') AS messages FROM authoring_chats c`
interface Row { id: string; course_id: string; model: string; provider: AIProvider; pinned_provider: string | null; reasoning: ReasoningEffort | null; title: string; messages: number; created_at: string; updated_at: string }
function summary(row: Row): ChatSummary { return { id: row.id, courseId: row.course_id, provider: row.provider, ...(isAIProvider(row.pinned_provider) ? { pinnedProvider: row.pinned_provider } : {}), model: row.model, reasoning: row.reasoning, title: row.title.slice(0, 120), messages: row.messages, createdAt: row.created_at, updatedAt: row.updated_at, startedIn: null, historyLabel: 'Course creation' } }
export function selectAuthoringChats(courseId: string): ChatSummary[] { return (db().prepare(`${SUMMARY} WHERE c.course_id=? ORDER BY updated_at DESC, c.rowid DESC LIMIT 200`).all(courseId) as unknown as Row[]).map(summary) }
export function selectAuthoringChat(id: string, database = db()): ChatSummary | null { const row = database.prepare(`${SUMMARY} WHERE c.id=?`).get(id) as unknown as Row | undefined; return row ? summary(row) : null }
export function insertAuthoringChat(chat: Omit<ChatSummary, 'startedIn' | 'title' | 'messages'>): void { db().prepare('INSERT INTO authoring_chats(id,course_id,model,reasoning,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(chat.id, chat.courseId, chat.model, chat.reasoning, chat.provider!, chat.createdAt, chat.updatedAt) }
export function selectAuthoringMessages(id: string, database = db()): ChatMessage[] { return (database.prepare('SELECT payload FROM authoring_messages WHERE chat_id=? ORDER BY seq DESC LIMIT 400').all(id) as { payload: string }[]).reverse().map(row => JSON.parse(row.payload)) }
export function appendAuthoringMessage(id: string, message: Omit<ChatMessage, 'seq'>, database = db()): number {
  const row = database.prepare('UPDATE authoring_chats SET next_seq=next_seq+1,updated_at=? WHERE id=? RETURNING next_seq-1 AS seq').get(message.at, id) as { seq: number } | undefined
  if (!row) throw new Error('This authoring chat no longer exists.')
  database.prepare('INSERT INTO authoring_messages(chat_id,seq,role,text,payload) VALUES(?,?,?,?,?)').run(id, row.seq, message.role, message.text, JSON.stringify({ ...message, seq: row.seq }))
  return row.seq
}
export function updateAuthoringChat(id: string, model: string, reasoning: ReasoningEffort | null, provider?: AIProvider): void { db().prepare('UPDATE authoring_chats SET model=?,reasoning=?,provider=COALESCE(?,provider) WHERE id=?').run(model, reasoning, provider ?? null, id) }
/** A conversation's own connection (null: follow Settings), with the model and level that go with it. */
export function pinAuthoringChatProvider(id: string, pinned: AIProvider | null, provider: AIProvider, model: string, reasoning: ReasoningEffort | null): void { db().prepare('UPDATE authoring_chats SET pinned_provider=?,provider=?,model=?,reasoning=? WHERE id=?').run(pinned, provider, model, reasoning, id) }
export function recordAuthoringTool(database: DatabaseSync, id: string, seq: number, callId: string, name: string, args: unknown, result: string): void {
  database.prepare('INSERT OR IGNORE INTO authoring_tool_calls(chat_id,message_seq,call_id,name,arguments,result,at) VALUES(?,?,?,?,?,?,?)').run(id, seq, callId, name, JSON.stringify(args), result.length > 80000 ? JSON.stringify({ truncated: true, excerpt: result.slice(0, 80000) }) : result, new Date().toISOString())
}
