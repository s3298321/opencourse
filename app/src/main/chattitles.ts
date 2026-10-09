import { getCourse } from './courses'
import { readDocument } from './course-store'
import type { WebContents } from 'electron'
import type { AIProvider, AIScope, ReasoningEffort } from '../core/types'
import { normalizeChatTitle, titleWordCount, TITLE_INSTRUCTIONS } from '../core/sidechat/title'
import { scrubSecrets } from '../core/coach/key'
import { db } from './db'
import { streamChat } from './openai'
import { currentUserId } from './users'
import { aiEvents, prepareTitleRequest } from './ai'
import { log } from './log'
import { whenSenderGone } from './senders'

const TABLES: Record<AIScope, string> = { chat: 'chats', project: 'course_project_chats', authoring: 'authoring_chats' }
const MESSAGES: Record<AIScope, string> = { chat: 'chat_messages', project: 'course_project_messages', authoring: 'authoring_messages' }
const pending = new Map<string, { controller: AbortController; scope: AIScope; chatId: string; provider: AIProvider; courseId: string; senderId: number }>()
aiEvents.on('changed', () => { cancelChatTitles('chat'); cancelChatTitles('project'); cancelChatTitles('authoring') })

export function cancelChatTitles(scope: AIScope, filter: { chatId?: string; provider?: AIProvider; courseId?: string; senderId?: number } = {}): void {
  for (const [id, task] of pending) {
    if (task.scope === scope && Object.entries(filter).every(([key, value]) => task[key as keyof typeof task] === value)) {
      task.controller.abort('cancelled')
      pending.delete(id)
    }
  }
}

/** A separate, best-effort request: it never holds up the answer or writes into its transcript. */
export async function generateChatTitle(options: {
  scope: AIScope; chatId: string; courseId: string; owner: string; sender: WebContents
  key: string; provider: AIProvider; model: string; reasoningEfforts: readonly ReasoningEffort[]
}): Promise<void> {
  const { scope, chatId, courseId, owner, sender, provider } = options
  const courseRevision = () => scope === 'authoring' ? readDocument(courseId).revision : getCourse(courseId)?.revision
  const revision = courseRevision()
  const id = `${scope}:${chatId}`
  const logger = log.child('chat.title', { userId: owner, data: { scope, chatId } })
  // Every abort says why, because a title that never arrives is otherwise
  // indistinguishable from one that was never asked for.
  const controller = new AbortController()
  const cancelled = (model?: string): void => logger.info('Naming a chat was cancelled', { ...(model ? { model } : {}), reason: String(controller.signal.reason ?? 'cancelled') })
  let cleanup = (): void => {}
  try {
    if (currentUserId() !== owner || sender.isDestroyed() || pending.has(id)) return
    const table = TABLES[scope]
    const row = db().prepare(`SELECT generated_title FROM ${table} WHERE id = ?`).get(chatId) as { generated_title: string | null } | undefined
    if (!row || row.generated_title !== null) return
    // A retry after a naming failure still names the first user message, even
    // if the conversation has moved on while the title request was pending.
    const messages = MESSAGES[scope]
    const prompt = db().prepare(`SELECT text FROM ${messages} WHERE chat_id = ? AND role = 'user' ORDER BY seq LIMIT 1`).get(chatId) as { text: string } | undefined
    if (!prompt) return
    const task = { controller, scope, chatId, provider, courseId, senderId: sender.id }
    pending.set(id, task)
    const unbind = whenSenderGone(sender, () => controller.abort('window'))
    const timeout = setTimeout(() => controller.abort('timeout'), 45_000)
    timeout.unref()
    cleanup = () => {
      clearTimeout(timeout)
      unbind()
      if (pending.get(id) === task) pending.delete(id)
    }
    const config = await prepareTitleRequest({ provider, model: options.model, reasoning: null, key: options.key, reasoningEfforts: options.reasoningEfforts }, controller.signal)
    task.provider = config.provider
    const result = await streamChat({
      key: config.key, provider: config.provider, model: config.model, ...(config.reasoning !== null ? { reasoning: config.reasoning } : {}),
      input: [
        { role: 'system', content: TITLE_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ prompt: prompt.text.slice(0, 4_000) }) }
      ],
      signal: controller.signal, onDelta: () => {}
    })
    if (result.aborted || controller.signal.aborted) return cancelled(config.model)
    const title = normalizeChatTitle(result.text)
    if (!title) {
      // Counts only: the reply is derived from the conversation.
      logger.warn('The title model returned nothing usable', { model: config.model, chars: result.text.length, words: titleWordCount(result.text) })
      return
    }
    if (pending.get(id) !== task || currentUserId() !== owner || courseRevision() !== revision || sender.isDestroyed()) {
      logger.info('A title arrived for a chat that had changed; dropped it', { model: config.model })
      return
    }
    const saved = db().prepare(`UPDATE ${table} SET generated_title = ? WHERE id = ? AND generated_title IS NULL`).run(title, chatId)
    if (Number(saved.changes)) sender.send(scope === 'chat' ? 'chat:title' : scope === 'project' ? 'projectChat:title' : 'authoringChat:title', chatId, title)
  } catch (error) {
    // Naming failures leave the prompt title in place; answering is unaffected.
    if (controller.signal.aborted) return cancelled()
    logger.warn('Naming a chat failed', { message: scrubSecrets(error instanceof Error ? error.message : 'Unknown error') })
  } finally { cleanup() }
}
