/**
 * Side chat's half of the database: chats and their messages.
 *
 * The handle, the pragmas and the migrations live in db.ts; everything here is
 * a prepared statement against it, bounded and filtered by chat or by course.
 *
 * A chat uses its AI-generated title once available, with the first prompt as
 * a temporary name. And `seq` is
 * allocated inside a transaction rather than by AUTOINCREMENT, so a message's
 * position in the conversation is a fact about the conversation and not about
 * the order two writes happened to reach SQLite.
 */
import { normalizeCitations } from '../core/sidechat/citations'
import { isReasoningEffort } from '../core/sidechat/models'
import { isAIProvider, validModelId } from '../core/ai'
import type { AIProvider, ChatCitation, ChatLessonRef, ChatMessage, ChatSummary, ReasoningEffort } from '../core/types'
import { registeredCourse, registeredElement } from './course-registry'
import { db, tx } from './db'

/** A chat's row, plus the two things every list of chats wants. */
const SUMMARY_COLUMNS = `c.*,
  (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id AND m.role <> 'context') AS message_count,
  (SELECT m.text FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.seq LIMIT 1) AS opener`

function chatSummary(row: Record<string, unknown>): ChatSummary {
  return {
    id: String(row['id']),
    courseId: String(row['course_slug']),
    model: String(row['model']),
    provider: row['provider'] === 'chatgpt' ? 'chatgpt' : 'apiKey',
    reasoning: isReasoningEffort(row['reasoning']) ? row['reasoning'] : null,
    startedIn: row['course_id'] && !row['start_lesson_id'] ? null : { moduleId: String(row['module_slug']), lessonId: String(row['lesson_slug']) },
    title: typeof row['generated_title'] === 'string' ? row['generated_title'] : typeof row['opener'] === 'string' ? row['opener'] : '',
    messages: Number(row['message_count'] ?? 0),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at'])
  }
}

export function insertChat(chat: {
  id: string
  courseId: string
  model: string
  provider?: AIProvider
  reasoning?: ReasoningEffort | null
  startedIn: ChatLessonRef
  at: string
}): void {
  db()
    .prepare(
      `INSERT INTO chats (id, course_slug, model, reasoning, module_slug, lesson_slug, created_at, updated_at, provider, course_id, start_lesson_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      chat.id,
      chat.courseId,
      chat.model,
      chat.reasoning ?? null,
      chat.startedIn.moduleId,
      chat.startedIn.lessonId,
      chat.at,
      chat.at,
      chat.provider ?? 'apiKey',
      registeredCourse(db(), chat.courseId),
      registeredElement(db(), chat.courseId, chat.startedIn.lessonId)
    )
}

/**
 * The row a tool call's worth of trust hangs on: `chat:send` is handed an id,
 * and this is what says which course it belongs to. Nothing downstream takes
 * the caller's word for that.
 */
export function selectChat(id: string): ChatSummary | null {
  const row = db()
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM chats c WHERE c.id = ?`)
    .get(id) as Record<string, unknown> | undefined
  return row ? chatSummary(row) : null
}

export function selectChats(courseId: string): ChatSummary[] {
  const rows = db()
    // The id is a tiebreaker, not a sort key: two chats started in the same
    // millisecond would otherwise come back in whatever order SQLite felt like,
    // and a history list that reshuffles itself between renders is a bug.
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM chats c WHERE c.course_slug = ?
       ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC`
    )
    .all(courseId) as Record<string, unknown>[]
  return rows.map(chatSummary)
}

export function selectMessages(chatId: string): ChatMessage[] {
  const rows = db()
    .prepare(
      `SELECT seq, role, text, quote, quote_from, sources, module_slug, lesson_slug, status, generation, context_fingerprint, at
       FROM chat_messages WHERE chat_id = ? ORDER BY seq`
    )
    .all(chatId) as Record<string, unknown>[]
  return rows.map((row) => {
    const role = row['role']
    const module = row['module_slug']
    const lesson = row['lesson_slug']
    const citations = readCitations(row['sources'])
    const generation = readGeneration(row['generation'])
    return {
      seq: Number(row['seq']),
      role: role === 'user' || role === 'context' ? (role as 'user' | 'context') : 'assistant',
      text: String(row['text']),
      ...(row['status'] === 'complete' || row['status'] === 'stopped' || row['status'] === 'failed' ? { status: row['status'] } : {}),
      ...(typeof row['quote'] === 'string' && row['quote']
        ? { quote: { text: row['quote'], from: row['quote_from'] === 'answer' ? 'answer' : 'lesson' } }
        : {}),
      ...(citations.length ? { citations } : {}),
      ...(generation ? { generation } : {}),
      ...(typeof row['context_fingerprint'] === 'string' ? { contextFingerprint: row['context_fingerprint'] } : {}),
      ...(typeof module === 'string' && typeof lesson === 'string'
        ? { lesson: { moduleId: module, lessonId: lesson } }
        : {}),
      at: String(row['at'])
    }
  })
}

/** The pages one answer cited - what the favicon lookup is allowed to ask about. */
export function selectMessageCitations(chatId: string, seq: number): ChatCitation[] {
  const row = db()
    .prepare('SELECT sources FROM chat_messages WHERE chat_id = ? AND seq = ?')
    .get(chatId, seq) as { sources?: unknown } | undefined
  return readCitations(row?.sources)
}

/** A row's sources: a column that does not parse costs the list, never the message. */
function readCitations(raw: unknown): ChatCitation[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    return normalizeCitations(JSON.parse(raw))
  } catch {
    return []
  }
}

function readGeneration(raw: unknown): ChatMessage['generation'] {
  if (typeof raw !== 'string') return undefined
  try {
    const value = JSON.parse(raw)
    return value && validModelId(value.model) && isAIProvider(value.provider) && (value.reasoning === null || isReasoningEffort(value.reasoning))
      ? { model: value.model, provider: value.provider, reasoning: value.reasoning } : undefined
  } catch { return undefined }
}

/**
 * Appends one message and returns the seq it landed at.
 *
 * A monotonic counter inside BEGIN IMMEDIATE keeps sequence identities stable
 * even after messages are cascade-deleted; touching the chat in
 * the same transaction is what keeps `updated_at` honest for the history list.
 */
export function appendMessage(
  chatId: string,
  message: Omit<ChatMessage, 'seq'>
): number {
  const citations = normalizeCitations(message.citations)
  return tx((d) => {
    const row = d.prepare('SELECT next_seq,course_slug,course_id FROM chats WHERE id=?').get(chatId) as { next_seq: number; course_slug: string; course_id: string | null } | undefined
    if (!row) throw new Error('That chat no longer exists.')
    const seq = row.next_seq
    const lessonId = message.lesson ? registeredElement(d, row.course_slug, message.lesson.lessonId) : null
    if (row.course_id && message.lesson && !lessonId) throw new Error('That lesson no longer exists.')
    d.prepare('UPDATE chats SET next_seq=next_seq+1 WHERE id=?').run(chatId)
    d.prepare(
      `INSERT INTO chat_messages (chat_id, seq, role, text, quote, quote_from, sources, module_slug, lesson_slug, at, status, generation, lesson_id, context_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chatId,
      seq,
      message.role,
      message.text,
      message.quote?.text ?? null,
      message.quote?.from ?? null,
      citations.length ? JSON.stringify(citations) : null,
      message.lesson?.moduleId ?? null,
      message.lesson?.lessonId ?? null,
      message.at,
      message.status ?? null,
      message.generation ? JSON.stringify(message.generation) : null,
      lessonId,
      message.contextFingerprint ?? null
    )
    d.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(message.at, chatId)
    return seq
  })
}

/** Both at once: a level the new model cannot take has to go in the same write. */
export function updateChatModel(id: string, model: string, reasoning: ReasoningEffort | null, provider?: AIProvider): void {
  db()
    .prepare('UPDATE chats SET model = ?, reasoning = ?, provider = COALESCE(?, provider), updated_at = ? WHERE id = ?')
    .run(model, reasoning, provider ?? null, new Date().toISOString(), id)
}

export function updateChatReasoning(id: string, reasoning: ReasoningEffort | null): void {
  db()
    .prepare('UPDATE chats SET reasoning = ?, updated_at = ? WHERE id = ?')
    .run(reasoning, new Date().toISOString(), id)
}

/** Messages go with it - that is what the cascade is for. */
export function deleteChatRow(id: string): void {
  db().prepare('DELETE FROM chats WHERE id = ?').run(id)
}
