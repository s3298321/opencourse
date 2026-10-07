import { getCourse } from './courses'
import { readDocument } from './course-store'
import type { WebContents } from 'electron'
import type { AIProvider, AIScope, ReasoningEffort } from '../core/types'
import { normalizeChatTitle, TITLE_INSTRUCTIONS } from '../core/sidechat/title'
import { scrubSecrets } from '../core/coach/key'
import { db } from './db'
import { streamChat } from './openai'
import { currentUserId } from './users'
import { aiEvents, prepareTitleRequest } from './ai'
import { log } from './log'

const TABLES: Record<AIScope, string> = { chat: 'chats', project: 'course_project_chats', authoring: 'authoring_chats' }
const pending = new Map<string, { controller: AbortController; scope: AIScope; chatId: string; provider: AIProvider; courseId: string; senderId: number }>()
aiEvents.on('changed', () => { cancelChatTitles('chat'); cancelChatTitles('project'); cancelChatTitles('authoring') })

export function cancelChatTitles(scope: AIScope, filter: { chatId?: string; provider?: AIProvider; courseId?: string; senderId?: number } = {}): void {
  for (const [id, task] of pending) {
    if (task.scope === scope && Object.entries(filter).every(([key, value]) => task[key as keyof typeof task] === value)) {
      task.controller.abort()
      pending.delete(id)
    }
  }
}

/** A separate, best-effort request: it never holds up the answer or writes into its transcript. */
export async function generateChatTitle(options: {
  scope: AIScope; chatId: string; courseId: string; owner: string; sender: WebContents
  key: string; provider: AIProvider; model: string; reasoningEfforts: readonly ReasoningEffort[]
  prompt: string; response: string
}): Promise<void> {
  const { scope, chatId, courseId, owner, sender, provider } = options
  const courseRevision = () => scope === 'authoring' ? readDocument(courseId).revision : getCourse(courseId)?.revision
  const revision = courseRevision()
  const id = `${scope}:${chatId}`
  let cleanup = (): void => {}
  try {
    if (currentUserId() !== owner || sender.isDestroyed() || pending.has(id)) return
    const table = TABLES[scope]
    const row = db().prepare(`SELECT generated_title FROM ${table} WHERE id = ?`).get(chatId) as { generated_title: string | null } | undefined
    if (!row || row.generated_title !== null) return
    const controller = new AbortController()
    const task = { controller, scope, chatId, provider, courseId, senderId: sender.id }
    pending.set(id, task)
    const abort = (): void => controller.abort()
    sender.once('destroyed', abort)
    sender.once('render-process-gone', abort)
    sender.once('did-start-loading', abort)
    const timeout = setTimeout(abort, 45_000)
    timeout.unref()
    cleanup = () => {
      clearTimeout(timeout)
      sender.removeListener('destroyed', abort)
      sender.removeListener('render-process-gone', abort)
      sender.removeListener('did-start-loading', abort)
      if (pending.get(id) === task) pending.delete(id)
    }
    const config = await prepareTitleRequest({ provider, model: options.model, reasoning: null, key: options.key, reasoningEfforts: options.reasoningEfforts }, controller.signal)
    task.provider = config.provider
    const result = await streamChat({
      key: config.key, provider: config.provider, model: config.model, ...(config.reasoning !== null ? { reasoning: config.reasoning } : {}),
      input: [
        { role: 'system', content: TITLE_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ prompt: options.prompt.slice(0, 4_000), response: options.response.slice(0, 12_000) }) }
      ],
      signal: controller.signal, onDelta: () => {}
    })
    const title = normalizeChatTitle(result.text)
    if (!title || result.aborted || controller.signal.aborted || pending.get(id) !== task || currentUserId() !== owner || courseRevision() !== revision || sender.isDestroyed()) return
    const saved = db().prepare(`UPDATE ${table} SET generated_title = ? WHERE id = ? AND generated_title IS NULL`).run(title, chatId)
    if (Number(saved.changes)) sender.send(scope === 'chat' ? 'chat:title' : scope === 'project' ? 'projectChat:title' : 'authoringChat:title', chatId, title)
  } catch (error) {
    // Naming failures leave the prompt title in place; the completed answer remains successful.
    log.child('chat.title', { userId: owner }).warn('Naming a chat failed', { scope, chatId, message: scrubSecrets(error instanceof Error ? error.message : 'Unknown error') })
  } finally { cleanup() }
}
