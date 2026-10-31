import { db, tx } from './db'
import { isAIProvider } from '../core/ai'
import { isReasoningEffort } from '../core/sidechat/models'
import type { AIProvider, ChatMessage, ReasoningEffort } from '../core/types'
import type { WritingNotebookChatSummary } from '../core/writing-notebooks/types'

const columns = `c.*,(SELECT json_extract(payload, '$.writingNotebook.title') FROM writing_notebook_messages m WHERE m.chat_id=c.id AND m.role='context' ORDER BY seq LIMIT 1) AS page_title,(SELECT COUNT(*) FROM writing_notebook_messages m WHERE m.chat_id=c.id AND m.role!='context') AS messages,
  (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.at') END FROM writing_notebook_messages m WHERE m.chat_id=c.id AND m.role!='context' ORDER BY seq DESC LIMIT 1) AS last_message_at,
  (SELECT text FROM writing_notebook_messages m WHERE m.chat_id=c.id AND m.role='user' ORDER BY seq LIMIT 1) AS opener`
function summary(row: Record<string, unknown>): WritingNotebookChatSummary {
  return { id: String(row.id), notebookId: String(row.notebook_id), startedOn: String(row.started_on), model: String(row.model), reasoning: isReasoningEffort(row.reasoning) ? row.reasoning : null,
    provider: row.provider === 'chatgpt' ? 'chatgpt' : 'apiKey', ...(isAIProvider(row.pinned_provider) ? { pinnedProvider: row.pinned_provider } : {}),
    title: String(row.generated_title ?? row.opener ?? ''), messages: Number(row.messages), historyLabel: String(row.page_title ?? 'Notebook'),
    lastMessageAt: typeof row.last_message_at === 'string' ? row.last_message_at : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
export function selectWritingNotebookChat(id: string): WritingNotebookChatSummary | null {
  const row = db().prepare(`SELECT ${columns} FROM writing_notebook_chats c WHERE c.id=?`).get(id) as Record<string, unknown> | undefined
  return row ? summary(row) : null
}
export function selectWritingNotebookChats(notebookId: string): WritingNotebookChatSummary[] {
  return (db().prepare(`SELECT ${columns} FROM writing_notebook_chats c WHERE notebook_id=? ORDER BY updated_at DESC,created_at DESC,id DESC`).all(notebookId) as Record<string, unknown>[]).map(summary)
}
export function insertWritingNotebookChat(chat: WritingNotebookChatSummary): void {
  db().prepare('INSERT INTO writing_notebook_chats(id,notebook_id,started_on,model,reasoning,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(chat.id, chat.notebookId, chat.startedOn, chat.model, chat.reasoning, chat.provider ?? 'apiKey', chat.createdAt, chat.updatedAt)
}
export function selectWritingNotebookMessages(id: string): ChatMessage[] {
  return (db().prepare('SELECT seq,role,text,payload FROM writing_notebook_messages WHERE chat_id=? ORDER BY seq').all(id) as { seq: number; role: ChatMessage['role']; text: string; payload: string }[]).map(row => {
    let payload: Partial<ChatMessage> = {}
    try { payload = JSON.parse(row.payload) } catch { /* Preserve text when metadata is damaged. */ }
    return { ...payload, seq: row.seq, role: row.role, text: row.text, at: payload.at ?? '' }
  })
}
export function appendWritingNotebookMessage(id: string, message: Omit<ChatMessage, 'seq'>): number {
  return tx(database => {
    const row = database.prepare('SELECT next_seq FROM writing_notebook_chats WHERE id=?').get(id) as { next_seq: number } | undefined
    if (!row) throw new Error('This chat no longer exists.')
    database.prepare('INSERT INTO writing_notebook_messages(chat_id,seq,role,text,payload) VALUES(?,?,?,?,?)').run(id, row.next_seq, message.role, message.text, JSON.stringify(message))
    database.prepare('UPDATE writing_notebook_chats SET next_seq=next_seq+1,updated_at=? WHERE id=?').run(message.at, id)
    return row.next_seq
  })
}
export function configureWritingNotebookChat(id: string, model: string, reasoning: ReasoningEffort | null, provider: AIProvider, pinned?: AIProvider | null): void {
  db().prepare('UPDATE writing_notebook_chats SET model=?,reasoning=?,provider=?,updated_at=? WHERE id=?').run(model, reasoning, provider, new Date().toISOString(), id)
  if (pinned !== undefined) db().prepare('UPDATE writing_notebook_chats SET pinned_provider=? WHERE id=?').run(pinned, id)
}
export function deleteWritingNotebookChatRow(id: string): void { db().prepare('DELETE FROM writing_notebook_chats WHERE id=?').run(id) }
