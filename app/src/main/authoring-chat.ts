import { app, type WebContents } from 'electron'
import type { AIProvider, AuthoringTarget, ChatQuote, ChatSendResult, ChatSummary, ReasoningEffort } from '../core/types'
import { newChatId } from '../core/sidechat/ids'
import { MAX_MESSAGE_CHARS, MAX_QUOTE_CHARS } from '../core/sidechat/thread'
import { authoringContext } from '../core/authoring/document'
import { AUTHORING_INSTRUCTIONS, AUTHORING_TOOLS } from '../core/authoring/tools'
import { runProjectAgent, type ResponseInput } from '../core/projects/agent'
import { scrubSecrets } from '../core/coach/key'
import { getAuthoringCourse, noteAuthoringChat } from './course-authoring'
import { readDocument } from './course-store'
import { conversationConfig, conversationModelContext, conversationReasoning, newAIConversation, pinnedConversation, prepareAIRequest, validateConversationModel } from './ai'
import { currentUserId, requireUser } from './users'
import { db } from './db'
import { streamChat } from './openai'
import { runAuthoringTool } from './authoring-tools'
import { beginAuthoringTurn, authoringRunState } from './authoring-state'
import { appendAuthoringMessage, insertAuthoringChat, pinAuthoringChatProvider, recordAuthoringTool, selectAuthoringChat, selectAuthoringChats, selectAuthoringMessages, updateAuthoringChat } from './authoring-chatdb'
import { cancelChatTitles, generateChatTitle } from './chattitles'
import { log } from './log'
import { whenSenderGone } from './senders'

interface Run { chat: ChatSummary; controller: AbortController; finish: (status: 'complete' | 'stopped' | 'failed', error?: string) => void }
const running = new Map<string, Run>()
function requireChat(id: string): ChatSummary {
  if (typeof id !== 'string') throw new Error('Invalid authoring chat.')
  const chat = selectAuthoringChat(id)
  if (!chat) throw new Error('That authoring chat does not exist.')
  readDocument(chat.courseId)
  return running.get(id)?.chat ?? conversationConfig('authoring', chat)
}
export function listAuthoringChats(courseId: string): ChatSummary[] { readDocument(courseId); return selectAuthoringChats(courseId).map(chat => running.get(chat.id)?.chat ?? conversationConfig('authoring', chat)) }
export function getAuthoringChat(id: string) { return { chat: requireChat(id), messages: selectAuthoringMessages(id) } }
export function createAuthoringChat(courseId: string): ChatSummary {
  readDocument(courseId)
  const at = new Date().toISOString(), chat = { id: newChatId(), courseId, ...newAIConversation('authoring'), createdAt: at, updatedAt: at }
  insertAuthoringChat(chat); return requireChat(chat.id)
}
export function cancelAuthoringChat(id: string): void {
  cancelChatTitles('authoring', { chatId: id })
  const run = running.get(id)
  if (run) { run.controller.abort(); run.finish('stopped') }
}
export function cancelAllAuthoringChats(provider?: AIProvider): void {
  cancelChatTitles('authoring', provider ? { provider } : {})
  for (const [id, run] of [...running]) if (!provider || run.chat.provider === provider) cancelAuthoringChat(id)
}
export function deleteAuthoringChat(id: string): void { requireChat(id); cancelAuthoringChat(id); db().prepare('DELETE FROM authoring_chats WHERE id=?').run(id) }
export function setAuthoringChatModel(id: string, model: string): ChatSummary {
  if (running.has(id)) throw new Error('Wait for this response before changing its model.')
  const chat = requireChat(id); validateConversationModel('authoring', model, undefined, chat.pinnedProvider)
  updateAuthoringChat(id, model, chat.reasoning && conversationReasoning('authoring', model, chat.pinnedProvider).includes(chat.reasoning) ? chat.reasoning : null, chat.provider)
  return requireChat(id)
}
export function setAuthoringChatReasoning(id: string, reasoning: ReasoningEffort | null): ChatSummary {
  if (running.has(id)) throw new Error('Wait for this response before changing its reasoning.')
  const chat = requireChat(id); validateConversationModel('authoring', chat.model, reasoning, chat.pinnedProvider)
  updateAuthoringChat(id, chat.model, reasoning, chat.provider); return requireChat(id)
}
/** This conversation's own connection; Settings' default is untouched. See setChatProvider. */
export function setAuthoringChatProvider(id: string, provider: AIProvider | null): ChatSummary {
  if (running.has(id)) throw new Error('Wait for this response before changing its connection.')
  requireChat(id)
  const next = pinnedConversation('authoring', provider)
  pinAuthoringChatProvider(id, next.pinned, next.provider, next.model, next.reasoning)
  return requireChat(id)
}
app.on('before-quit', () => cancelAllAuthoringChats())

export async function sendAuthoringMessage(sender: WebContents, id: string, text: string, target: AuthoringTarget, expectedRevision: number, expectedDraftVersion: number, quote?: ChatQuote): Promise<ChatSendResult> {
  let chat = requireChat(id)
  const owner = requireUser(), database = db()
  if (authoringRunState(chat.courseId).chatId) return { status: 'busy' }
  const asked = String(text ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
  if (!asked) return { status: 'failed', message: 'There is nothing to ask.' }
  const authoring = getAuthoringCourse(chat.courseId)
  if (authoring.document.revision !== expectedRevision || authoring.draft.draftVersion !== expectedDraftVersion || authoring.draft.baseRevision !== expectedRevision) return { status: 'failed', message: 'The draft changed in another window. Reload it before asking the assistant.' }
  let context: ReturnType<typeof authoringContext>
  try { context = authoringContext(authoring.draft.manifest, target, expectedDraftVersion) }
  catch (error) { return { status: 'failed', message: (error as Error).message } }
  // A chat used while editing follows the edits if they are saved as a local copy.
  noteAuthoringChat(chat.courseId, id)
  const controller = new AbortController()
  const logger = log.child('authoring', { userId: owner, data: { chatId: id, courseId: chat.courseId } })
  const started = Date.now()
  let toolCalls = 0
  let answered = '', finalized = false, seq = -1
  let release = () => {}, unbindLost = () => {}, timer: ReturnType<typeof setTimeout> | undefined
  const push = (channel: string, ...args: unknown[]) => { if (!sender.isDestroyed()) sender.send(channel, id, ...args) }
  const lost = () => { controller.abort(); finish('stopped') }
  const finish = (status: 'complete' | 'stopped' | 'failed', error?: string): void => {
    if (finalized) return
    finalized = true; clearTimeout(timer); running.delete(id)
    unbindLost()
    try {
      if (currentUserId() === owner && selectAuthoringChat(id, database) && answered) appendAuthoringMessage(id, { role: 'assistant', text: answered, status, generation: { model: chat.model, provider: chat.provider!, reasoning: chat.reasoning }, at: new Date().toISOString() }, database)
    } catch (failure) { error ??= (failure as Error).message }
    finally { release() }
    const outcome = { model: chat.model, provider: chat.provider ?? 'apiKey', reasoning: chat.reasoning ?? null, ms: Date.now() - started, chars: answered.length, toolCalls }
    if (error) logger.error('Authoring turn failed', { ...outcome, message: error })
    else if (status === 'failed') logger.warn('Authoring turn ended without an answer', outcome)
    else logger.info(status === 'complete' ? 'Authoring turn complete' : 'Authoring turn stopped', outcome)
    if (error) push('authoringChat:error', scrubSecrets(error)); else push('authoringChat:done')
  }
  let token: symbol
  try { const lease = beginAuthoringTurn(chat.courseId, id, lost); token = lease.token; release = lease.release }
  catch (error) { return { status: 'failed', message: (error as Error).message } }
  running.set(id, { chat, controller, finish })
  unbindLost = whenSenderGone(sender, lost)
  let key: string
  try { ({ chat, key } = await prepareAIRequest('authoring', chat, controller.signal)) }
  catch (error) {
    if (!controller.signal.aborted) logger.warn('The connection was not ready for an authoring turn', { provider: chat.provider ?? 'apiKey', message: (error as Error).message })
    finish(controller.signal.aborted ? 'stopped' : 'failed')
    return { status: 'connection-required', provider: chat.provider!, message: controller.signal.aborted ? 'Message stopped before sending.' : scrubSecrets((error as Error).message) }
  }
  if (finalized || controller.signal.aborted || currentUserId() !== owner) { finish('stopped'); return { status: 'failed', message: 'Authoring stopped before sending.' } }
  running.get(id)!.chat = chat
  const modelContext = conversationModelContext(chat.provider!, chat.model)
  const at = new Date().toISOString(), metadata = { target: context.target, label: context.label, draftVersion: expectedDraftVersion }
  const quoted = typeof quote?.text === 'string' ? quote.text.trim().slice(0, MAX_QUOTE_CHARS) : ''
  const quoteSource = quote?.from === 'answer' ? 'answer' as const : 'preview' as const
  try {
    updateAuthoringChat(id, chat.model, chat.reasoning, chat.provider)
    appendAuthoringMessage(id, { role: 'context', text: JSON.stringify(context), authoring: metadata, at }, database)
    seq = appendAuthoringMessage(id, { role: 'user', text: asked, authoring: metadata, ...(quoted ? { quote: { text: quoted, from: quoteSource } } : {}), at }, database)
  } catch (error) { finish('failed', (error as Error).message); return { status: 'failed', message: (error as Error).message } }
  const input: ResponseInput[] = [{ role: 'system', content: AUTHORING_INSTRUCTIONS }]
  const kept: ResponseInput[] = []
  let available = 120000
  let history: ReturnType<typeof selectAuthoringMessages>
  try { history = selectAuthoringMessages(id, database) }
  catch (error) { finish('failed', (error as Error).message); return { status: 'failed', message: (error as Error).message } }
  for (const message of [...history].reverse()) {
    const content = message.role === 'context' ? `[Authoring context for the following user message]\n${message.text}` : message.quote ? `${message.quote.from === 'answer' ? 'Quoted earlier answer' : 'Quoted course preview passage'}:\n${message.quote.text}\n\n${message.text}` : message.text
    if (content.length > available && kept.length) break
    available -= content.length; kept.unshift({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
  }
  input.push(...kept)
  timer = setTimeout(() => { controller.abort(); finish('failed', 'Course creation timed out. Completed draft changes are preserved; send another message to continue.') }, 30 * 60_000)
  setImmediate(() => { void (async () => {
    try {
      const result = await runProjectAgent({ input, signal: controller.signal, limits: { rounds: 64, calls: 256 },
        stream: items => {
          let first = true
          return streamChat({ key, provider: chat.provider, model: chat.model, modelContext, input: items, tools: AUTHORING_TOOLS,
            toolNamespace: { name: 'authoring', description: 'Create and edit this course draft and its supporting assets.' },
            ...(chat.reasoning ? { reasoning: chat.reasoning } : {}), signal: controller.signal,
            onDelta: chunk => { if (!finalized) { const delta = first && answered ? `\n\n${chunk}` : chunk; first = false; answered += delta; push('authoringChat:delta', delta) } } })
        },
        tool: async (name, args, callId) => {
          if (finalized || controller.signal.aborted || currentUserId() !== owner) throw new Error('Authoring stopped.')
          if (readDocument(chat.courseId).revision !== expectedRevision) throw new Error('The saved course changed.')
          push('authoringChat:activity', name.replace(/_/g, ' '))
          toolCalls++
          let output: string
          try { output = await runAuthoringTool(chat.courseId, name, args, token, controller.signal) }
          catch (error) { logger.warn('An authoring tool failed', { tool: name, error }); throw error }
          if (!finalized && currentUserId() === owner) recordAuthoringTool(database, id, seq, callId, name, args, output)
          return output
        }
      })
      finish(result.stopped ? 'stopped' : 'complete')
      if (!result.stopped && !controller.signal.aborted && currentUserId() === owner && answered.trim()) void generateChatTitle({ scope: 'authoring', chatId: id, courseId: chat.courseId, owner, sender, key, provider: chat.provider!, model: chat.model, reasoningEfforts: conversationReasoning('authoring', chat.model, chat.pinnedProvider), prompt: asked, response: answered })
    } catch (error) { finish(controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? undefined : (error as Error).message) }
  })() })
  return { status: 'ok', seq }
}
