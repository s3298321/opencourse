import { db, tx } from './db'
import { isAIProvider } from '../core/ai'
import { isReasoningEffort } from '../core/sidechat/models'
import type { AIProvider, ChatMessage, ReasoningEffort } from '../core/types'
import type { DocumentChatSummary } from '../core/documents/types'

const columns = `c.*,(SELECT COUNT(*) FROM document_messages m WHERE m.chat_id=c.id AND m.role!='context') AS messages,
  (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.at') END FROM document_messages m WHERE m.chat_id=c.id AND m.role!='context' ORDER BY seq DESC LIMIT 1) AS last_message_at,
  (SELECT text FROM document_messages m WHERE m.chat_id=c.id AND m.role='user' ORDER BY seq LIMIT 1) AS opener`
function summary(row: Record<string, unknown>): DocumentChatSummary {
  return { id: String(row.id), documentId: String(row.document_id), startedOn: Number(row.started_on), model: String(row.model), reasoning: isReasoningEffort(row.reasoning) ? row.reasoning : null,
    provider: row.provider === 'chatgpt' ? 'chatgpt' : 'apiKey', ...(isAIProvider(row.pinned_provider) ? { pinnedProvider: row.pinned_provider } : {}),
    title: String(row.generated_title ?? row.opener ?? ''), messages: Number(row.messages), historyLabel: `Page ${row.started_on}`,
    lastMessageAt: typeof row.last_message_at === 'string' ? row.last_message_at : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
export function selectDocumentChat(id: string): DocumentChatSummary | null {
  const row = db().prepare(`SELECT ${columns} FROM document_chats c WHERE c.id=?`).get(id) as Record<string, unknown> | undefined
  return row ? summary(row) : null
}
export function selectDocumentChats(documentId: string): DocumentChatSummary[] {
  return (db().prepare(`SELECT ${columns} FROM document_chats c WHERE document_id=? ORDER BY updated_at DESC,created_at DESC,id DESC`).all(documentId) as Record<string, unknown>[]).map(summary)
}
export function insertDocumentChat(chat: DocumentChatSummary): void {
  db().prepare('INSERT INTO document_chats(id,document_id,started_on,model,reasoning,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(chat.id, chat.documentId, chat.startedOn, chat.model, chat.reasoning, chat.provider ?? 'apiKey', chat.createdAt, chat.updatedAt)
}
export function selectDocumentMessages(id: string): ChatMessage[] {
  return (db().prepare('SELECT seq,role,text,payload FROM document_messages WHERE chat_id=? ORDER BY seq').all(id) as { seq: number; role: ChatMessage['role']; text: string; payload: string }[]).map(row => {
    let payload: Partial<ChatMessage> = {}
    try { payload = JSON.parse(row.payload) } catch { /* Preserve text when metadata is damaged. */ }
    return { ...payload, seq: row.seq, role: row.role, text: row.text, at: payload.at ?? '' }
  })
}
export function appendDocumentMessage(id: string, message: Omit<ChatMessage, 'seq'>): number {
  return tx(database => {
    const row = database.prepare('SELECT next_seq FROM document_chats WHERE id=?').get(id) as { next_seq: number } | undefined
    if (!row) throw new Error('This chat no longer exists.')
    database.prepare('INSERT INTO document_messages(chat_id,seq,role,text,payload) VALUES(?,?,?,?,?)').run(id, row.next_seq, message.role, message.text, JSON.stringify(message))
    database.prepare('UPDATE document_chats SET next_seq=next_seq+1,updated_at=? WHERE id=?').run(message.at, id)
    return row.next_seq
  })
}
export function configureDocumentChat(id: string, model: string, reasoning: ReasoningEffort | null, provider: AIProvider, pinned?: AIProvider | null): void {
  db().prepare('UPDATE document_chats SET model=?,reasoning=?,provider=?,updated_at=? WHERE id=?').run(model, reasoning, provider, new Date().toISOString(), id)
  if (pinned !== undefined) db().prepare('UPDATE document_chats SET pinned_provider=? WHERE id=?').run(pinned, id)
}
export function deleteDocumentChatRow(id: string): void { db().prepare('DELETE FROM document_chats WHERE id=?').run(id) }
