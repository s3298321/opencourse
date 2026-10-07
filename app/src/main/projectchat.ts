import { getCourse } from './courses'
import { app, type WebContents } from 'electron'
import type { ChatQuote, ChatSendResult, ProjectChatSummary, ProjectTarget, ReasoningEffort } from '../core/types'
import { newChatId } from '../core/sidechat/ids'
import { MAX_MESSAGE_CHARS, MAX_QUOTE_CHARS } from '../core/sidechat/thread'
import { PROJECT_INSTRUCTIONS, REVIEW_REQUEST } from '../core/projects/prompt'
import { PROJECT_TOOLS } from '../core/projects/tools'
import { runProjectAgent, type ResponseInput } from '../core/projects/agent'
import { requireCourseProject, projectScope } from './courseprojects'
import { assertProjectPath, runProjectFileTool } from './projectfiles'
import { readKey } from './coachkey'
import { scrubSecrets } from '../core/coach/key'
import { streamChat } from './openai'
import { db } from './db'
import { requireUser } from './users'
import { conversationConfig, conversationModelContext, conversationReasoning, newAIConversation, prepareAIRequest, profileFor, validateConversationModel } from './ai'
import { currentUserId } from './users'
import { updateProgress } from './progress'
import { appendProjectMessage, deleteProjectChatRow, insertProjectChat, recordProjectTool, selectProjectChat, selectProjectChats, selectProjectMessages, updateProjectChat } from './projectchatdb'
import { cancelChatTitles, generateChatTitle } from './chattitles'
import { log } from './log'

const inflight = new Map<string, { controller: AbortController; chat: ProjectChatSummary; finish: (status: 'complete' | 'stopped' | 'failed', error?: string) => void }>()
const preparing = new Map<string, { controller: AbortController; provider: import('../core/types').AIProvider }>()
export function cancelProjectChat(id: string): void {
  cancelChatTitles('project', { chatId: id })
  preparing.get(id)?.controller.abort()
  const entry = inflight.get(id)
  if (entry) { entry.controller.abort(); entry.finish('stopped') }
}
export function cancelAllProjectChats(provider?: import('../core/types').AIProvider): void {
  cancelChatTitles('project', provider ? { provider } : {})
  for (const entry of preparing.values()) if (!provider || entry.provider === provider) entry.controller.abort()
  for (const [id, entry] of [...inflight]) if (!provider || entry.chat.provider === provider) cancelProjectChat(id)
}
export function cancelCourseProjectChats(courseId: string): void {
  cancelChatTitles('project', { courseId })
  for (const id of new Set([...inflight.keys(), ...preparing.keys()])) {
    if (selectProjectChat(id)?.courseId === courseId) cancelProjectChat(id)
  }
}
app.on('before-quit', () => cancelAllProjectChats())
function requireChat(id: string): ProjectChatSummary {
  if (typeof id !== 'string') throw new Error('Invalid project chat.')
  const chat = selectProjectChat(id)
  if (!chat) throw new Error('That project chat does not exist.')
  return chatConfig(chat)
}
function chatConfig(chat: ProjectChatSummary): ProjectChatSummary {
  const snapshot = inflight.get(chat.id)?.chat
  return snapshot ? { ...chat, model: snapshot.model, reasoning: snapshot.reasoning, provider: snapshot.provider } : conversationConfig('project', chat)
}
export function listProjectChats(target: ProjectTarget) { requireCourseProject(target); return selectProjectChats(target.courseId, target.moduleId).map(chatConfig) }
export function getProjectChat(id: string) { const chat = requireChat(id); return { chat, messages: selectProjectMessages(id) } }
export function createProjectChat(target: ProjectTarget): ProjectChatSummary {
  requireCourseProject(target)
  const at = new Date().toISOString()
  const chat = { id: newChatId(), ...target, ...newAIConversation('project'), createdAt: at, updatedAt: at }
  insertProjectChat(chat)
  return requireChat(chat.id)
}
export function deleteProjectChat(id: string): void { requireChat(id); cancelProjectChat(id); deleteProjectChatRow(id) }
export function setProjectChatModel(id: string, model: string): ProjectChatSummary {
  if (inflight.has(id) || preparing.has(id)) throw new Error('Wait for the current response before changing its model.')
  const chat = requireChat(id)
  validateConversationModel('project', model)
  updateProjectChat(id, model, chat.reasoning && conversationReasoning('project', model).includes(chat.reasoning) ? chat.reasoning : null, chat.provider)
  return requireChat(id)
}
export function setProjectChatReasoning(id: string, reasoning: ReasoningEffort | null): ProjectChatSummary {
  if (inflight.has(id) || preparing.has(id)) throw new Error('Wait for the current response before changing its reasoning.')
  const chat = requireChat(id)
  validateConversationModel('project', chat.model, reasoning)
  updateProjectChat(id, chat.model, reasoning, chat.provider)
  return requireChat(id)
}

export async function sendProjectMessage(sender: WebContents, id: string, text: string, quote?: ChatQuote, review = false): Promise<ChatSendResult> {
  let chat = requireChat(id)
  const owner = requireUser()
  if (inflight.has(id) || preparing.has(id)) return { status: 'busy' }
  const asked = review ? REVIEW_REQUEST : String(text ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
  if (!asked) return { status: 'failed', message: 'There is nothing to ask.' }
  if (profileFor('project').provider === 'apiKey' && !readKey()) return { status: 'no-key' }
  let key: string
  const preparation = new AbortController(), stopPreparation = (): void => preparation.abort()
  preparing.set(id, { controller: preparation, provider: chat.provider ?? 'apiKey' })
  sender.once('destroyed', stopPreparation); sender.once('render-process-gone', stopPreparation); sender.once('did-start-loading', stopPreparation)
  const logger = log.child('project', { userId: owner, data: { chatId: id, courseId: chat.courseId, moduleId: chat.moduleId } })
  try { ({ chat, key } = await prepareAIRequest('project', chat, preparation.signal)) }
  catch (error) {
    if (preparation.signal.aborted) return { status: 'failed', message: 'Message stopped before sending.' }
    logger.warn('The connection was not ready for a question', { provider: chat.provider ?? 'apiKey', message: (error as Error).message })
    return { status: 'connection-required', provider: chat.provider ?? 'apiKey', message: (error as Error).message }
  }
  finally {
    preparing.delete(id)
    sender.removeListener('destroyed', stopPreparation); sender.removeListener('render-process-gone', stopPreparation); sender.removeListener('did-start-loading', stopPreparation)
  }
  if (preparation.signal.aborted) return { status: 'failed', message: 'Message stopped before sending.' }
  if (currentUserId() !== owner) return { status: 'failed', message: 'The local user changed.' }
  if (inflight.has(id)) return { status: 'busy' }
  const modelContext = conversationModelContext(chat.provider ?? 'apiKey', chat.model)
  updateProjectChat(id, chat.model, chat.reasoning, chat.provider)
  const target = { courseId: chat.courseId, moduleId: chat.moduleId }
  let context: string, fingerprint: string, scope: ReturnType<typeof projectScope>
  try {
    ({ context, fingerprint } = requireCourseProject(target))
    scope = projectScope(target)
    assertProjectPath(scope, '', true)
  } catch (err) { return { status: 'failed', message: scrubSecrets((err as Error).message) } }
  const revision = getCourse(chat.courseId)?.revision
  const database = db()
  const at = new Date().toISOString()
  const stored = selectProjectMessages(id, database)
  if (stored.filter((m) => m.role === 'context').at(-1)?.project?.fingerprint !== fingerprint) {
    appendProjectMessage(id, { role: 'context', text: context, project: { moduleId: chat.moduleId, fingerprint }, at }, database)
  }
  const quoted = typeof quote?.text === 'string' ? quote.text.trim().slice(0, MAX_QUOTE_CHARS) : ''
  const seq = appendProjectMessage(id, { role: 'user', text: asked, ...(quoted ? { quote: { text: quoted, from: 'answer' as const } } : {}), at }, database)
  const input: ResponseInput[] = [{ role: 'system', content: PROJECT_INSTRUCTIONS }, { role: 'user', content: `[current project context]\n\n${context}` }]
  const history = selectProjectMessages(id, database).filter((m) => m.role !== 'context')
  let available = 120000 - PROJECT_INSTRUCTIONS.length - context.length
  const kept: ResponseInput[] = []
  for (const message of [...history].reverse()) {
    const content = message.quote ? `Quoted from an earlier answer:\n${message.quote.text}\n\n${message.text}` : message.text
    if (content.length > available && kept.length) break
    available -= content.length
    kept.unshift({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
  }
  input.push(...kept)
  const controller = new AbortController()
  const titleReasoning = conversationReasoning('project', chat.model)
  let answered = ''
  let finalized = false
  let toolCalls = 0
  const started = Date.now()
  let turnTimer: ReturnType<typeof setTimeout> | undefined
  const push = (channel: string, ...args: unknown[]): void => { if (!sender.isDestroyed()) sender.send(channel, id, ...args) }
  const finish = (status: 'complete' | 'stopped' | 'failed', error?: string): void => {
    if (finalized) return
    finalized = true
    clearTimeout(turnTimer)
    inflight.delete(id)
    sender.removeListener('destroyed', lost)
    sender.removeListener('render-process-gone', lost)
    sender.removeListener('did-start-loading', lost)
    let assistantSeq = -1
    const valid = currentUserId() === owner && getCourse(chat.courseId)?.revision === revision && !!selectProjectChat(id, database)
    if (answered && valid) assistantSeq = appendProjectMessage(id, { role: 'assistant', text: answered, status,
      generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' }, at: new Date().toISOString() }, database)
    if (review && status === 'complete' && assistantSeq >= 0 && requireUser() === owner) {
      updateProgress(chat.courseId, (p) => ({ ...p, projects: { ...p.projects, [chat.moduleId]: { ...p.projects[chat.moduleId], reviewedFingerprint: fingerprint, lastReview: { chatId: id, seq: assistantSeq, at: new Date().toISOString(), fingerprint } } } }))
    }
    const outcome = { model: chat.model, provider: chat.provider ?? 'apiKey', reasoning: chat.reasoning ?? null, review, ms: Date.now() - started, chars: answered.length, toolCalls }
    if (error) logger.error('Answer failed', { ...outcome, message: error })
    else if (status === 'failed') logger.warn('Answer ended without a reply', outcome)
    else logger.info(status === 'complete' ? 'Answer complete' : 'Answer stopped', outcome)
    if (error) push('projectChat:error', scrubSecrets(error))
    else push('projectChat:done')
    if (valid && status === 'complete' && answered.trim() && !controller.signal.aborted) void generateChatTitle({
      scope: 'project', chatId: id, courseId: chat.courseId, owner, sender,
      key, provider: chat.provider ?? 'apiKey', model: chat.model, reasoningEfforts: titleReasoning,
      prompt: asked, response: answered
    })
  }
  const lost = (): void => { controller.abort(); finish('stopped') }
  sender.once('destroyed', lost)
  sender.once('render-process-gone', lost)
  sender.once('did-start-loading', lost)
  inflight.set(id, { controller, finish, chat })
  const budget = { bytes: 0, signal: controller.signal }
  turnTimer = setTimeout(() => {
    controller.abort()
    finish('failed', 'The project review timed out. Ask a more focused question to continue.')
  }, 18 * 60_000)
  // Queue work after the IPC acknowledgement so the renderer installs its busy buffer first.
  setImmediate(() => { void (async () => {
    try {
      const result = await runProjectAgent({
        input, signal: controller.signal,
        stream: (items) => {
          let firstDelta = true
          return streamChat({ key, provider: chat.provider, model: chat.model, modelContext, input: items, tools: PROJECT_TOOLS, ...(chat.reasoning ? { reasoning: chat.reasoning } : {}), signal: controller.signal, onDelta: (chunk) => {
            if (finalized) return
            const separated = firstDelta && answered ? `\n\n${chunk}` : chunk
            firstDelta = false
            answered += separated
            push('projectChat:delta', separated)
          } })
        },
        tool: async (name, args, callId) => {
          if (finalized || controller.signal.aborted || requireUser() !== owner) throw new Error('Project review stopped.')
          const path = (args as { path?: unknown })?.path
          push('projectChat:activity', `${name === 'read_project_file' ? 'Reading' : name === 'search_project_files' ? 'Searching' : 'Listing'} ${typeof path === 'string' && path ? path : 'project files'}`)
          toolCalls++
          let output: string
          try { output = await runProjectFileTool(scope, name, args, budget) }
          catch (error) { logger.warn('A project tool failed', { tool: name, error }); throw error }
          if (!finalized && requireUser() === owner) recordProjectTool(database, id, seq, callId, name, args, output)
          return output
        }
      })
      finish(result.stopped ? 'stopped' : 'complete')
    } catch (err) { if (!finalized) finish(controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? undefined : (err as Error).message) }
  })() })
  return { status: 'ok', seq }
}
