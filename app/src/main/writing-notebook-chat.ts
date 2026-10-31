import { type WebContents } from 'electron'
import { newChatId } from '../core/sidechat/ids'
import { buildInput, MAX_MESSAGE_CHARS, MAX_QUOTE_CHARS } from '../core/sidechat/thread'
import { webSearchFor } from '../core/sidechat/models'
import { READING_LIMITS, READING_TOOL_INSTRUCTIONS } from '../core/reading/tools'
import { runChatAgent } from './text-chat'
import { scrubSecrets } from '../core/coach/key'
import type { AIProvider, ChatCitation, ChatQuote, ChatSendResult, ReasoningEffort } from '../core/types'
import type { WritingNotebookChatSummary, WritingNotebookChatThread } from '../core/writing-notebooks/types'
import type { ReadingSource } from '../core/documents/types'
import { conversationConfig, conversationModelContext, conversationReasoning, newAIConversation, pinnedConversation, prepareAIRequest, validateConversationModel } from './ai'
import { appendWritingNotebookMessage, configureWritingNotebookChat, deleteWritingNotebookChatRow, insertWritingNotebookChat, selectWritingNotebookChat, selectWritingNotebookChats, selectWritingNotebookMessages } from './writing-notebook-chatdb'
import { writingNotebookEvents, getWritingNotebook, getWritingPage } from './writing-notebooks'
import { writingReadingTools, runWritingReadingTool, notebookSnapshot } from './writing-notebook-reading'
import { readPreferences } from './preferences'
import { currentUserId, requireUser } from './users'
import { streamChat } from './openai'
import { whenSenderGone } from './senders'
import { cancelChatTitles, generateChatTitle } from './chattitles'
import { iconsFor } from './favicons'
import { log } from './log'

interface Inflight { controller: AbortController; provider: AIProvider; notebookId: string; chat?: WritingNotebookChatSummary; stop?: () => void }
const inflight = new Map<string, Inflight>()
export function cancelWritingNotebookChat(id: string): void {
  cancelChatTitles('writing-notebook', { chatId: id })
  const entry = inflight.get(id); entry?.controller.abort(); entry?.stop?.()
}
export function cancelAllWritingNotebookChats(provider?: AIProvider): void {
  cancelChatTitles('writing-notebook', provider ? { provider } : {})
  for (const [id, entry] of inflight) if (!provider || entry.provider === provider) cancelWritingNotebookChat(id)
}
writingNotebookEvents.on('removing', (id: string) => {
  for (const [chatId, entry] of inflight) if (entry.notebookId === id) cancelWritingNotebookChat(chatId)
  for (const chat of selectWritingNotebookChats(id)) cancelChatTitles('writing-notebook', { chatId: chat.id })
})
function requireChat(id: string): WritingNotebookChatSummary {
  const chat = selectWritingNotebookChat(id)
  if (!chat) throw new Error('This notebook chat no longer exists.')
  return chatConfig(chat)
}
function chatConfig(chat: WritingNotebookChatSummary): WritingNotebookChatSummary {
  const snapshot = inflight.get(chat.id)?.chat
  return snapshot ? { ...chat, model: snapshot.model, reasoning: snapshot.reasoning, provider: snapshot.provider } : conversationConfig('chat', chat)
}
export function listWritingNotebookChats(id: string): WritingNotebookChatSummary[] {
  getWritingNotebook(id)
  return selectWritingNotebookChats(id).map(chatConfig)
}
export function getWritingNotebookChat(id: string): WritingNotebookChatThread | null {
  return selectWritingNotebookChat(id) ? { chat: requireChat(id), messages: selectWritingNotebookMessages(id) } : null
}
export function createWritingNotebookChat(notebookId: string, page: string): WritingNotebookChatSummary {
  getWritingPage(notebookId, page)
  const at = new Date().toISOString()
  const id = newChatId()
  insertWritingNotebookChat({ id, notebookId, startedOn: page, ...newAIConversation('chat'), title: '', messages: 0, createdAt: at, updatedAt: at })
  return requireChat(id)
}
function mutableChat(id: string): WritingNotebookChatSummary {
  if (inflight.has(id)) throw new Error('Wait for the response before changing this chat.')
  return requireChat(id)
}
export function setWritingNotebookChatModel(id: string, model: string): WritingNotebookChatSummary {
  const chat = mutableChat(id)
  validateConversationModel('chat', model, undefined, chat.pinnedProvider)
  const reasoning = chat.reasoning && conversationReasoning('chat', model, chat.pinnedProvider).includes(chat.reasoning) ? chat.reasoning : null
  configureWritingNotebookChat(id, model, reasoning, chat.provider ?? 'apiKey')
  return requireChat(id)
}
export function setWritingNotebookChatReasoning(id: string, reasoning: ReasoningEffort | null): WritingNotebookChatSummary {
  const chat = mutableChat(id)
  validateConversationModel('chat', chat.model, reasoning, chat.pinnedProvider)
  configureWritingNotebookChat(id, chat.model, reasoning, chat.provider ?? 'apiKey')
  return requireChat(id)
}
export function setWritingNotebookChatProvider(id: string, provider: AIProvider | null): WritingNotebookChatSummary {
  mutableChat(id)
  const config = pinnedConversation('chat', provider)
  configureWritingNotebookChat(id, config.model, config.reasoning, config.provider, config.pinned)
  return requireChat(id)
}
export function deleteWritingNotebookChat(id: string): void { cancelWritingNotebookChat(id); deleteWritingNotebookChatRow(id) }
export async function writingSourceIcons(id: string, seq: number): Promise<Record<string, string | null>> {
  requireChat(id)
  const message = selectWritingNotebookMessages(id).find(message => message.seq === seq)
  return iconsFor((message?.citations ?? []).flatMap(citation => { try { return [new URL(citation.url).hostname] } catch { return [] } }))
}
export async function sendWritingNotebookMessage(sender: WebContents, id: string, text: string, quote: ChatQuote | undefined, page: string): Promise<ChatSendResult> {
  let chat = requireChat(id)
  const owner = requireUser(), asked = typeof text === 'string' ? text.trim().slice(0, MAX_MESSAGE_CHARS) : ''
  if (!asked) return { status: 'failed', message: 'There is nothing to ask.' }
  if (inflight.has(id)) return { status: 'busy' }
  const document = getWritingNotebook(chat.notebookId)
  const savedPage = getWritingPage(document.id, page)
  const snapshot = notebookSnapshot(document)
  const pageContext = { notebookId: document.id, pageId: page, revision: savedPage.revision, title: savedPage.title }
  const tools = writingReadingTools(document)
  const controller = new AbortController(), entry: Inflight = { controller, provider: chat.provider ?? 'apiKey', notebookId: chat.notebookId }
  inflight.set(id, entry)
  const push = (channel: string, ...args: unknown[]): void => { if (!sender.isDestroyed() && currentUserId() === owner) sender.send(`writingChat:${channel}`, id, ...args) }
  const valid = (): boolean => currentUserId() === owner && !!selectWritingNotebookChat(id)
  const unbind = whenSenderGone(sender, () => cancelWritingNotebookChat(id))
  let key: string
  try { ({ chat, key } = await prepareAIRequest('chat', chat, controller.signal)) }
  catch (error) {
    inflight.delete(id); unbind()
    return { status: 'connection-required', provider: chat.provider ?? 'apiKey', message: scrubSecrets((error as Error).message) }
  }
  if (controller.signal.aborted || !valid()) { inflight.delete(id); unbind(); return { status: 'failed', message: 'Message stopped before sending.' } }
  entry.provider = chat.provider ?? 'apiKey'
  entry.chat = chat
  try {
    configureWritingNotebookChat(id, chat.model, chat.reasoning, chat.provider ?? 'apiKey')
    const messages = selectWritingNotebookMessages(id), previous = [...messages].reverse().find(message => message.role === 'context')
    if (previous?.writingNotebook?.pageId !== page || previous.writingNotebook.revision !== savedPage.revision) appendWritingNotebookMessage(id, {
      role: 'context', text: `Notebook: ${document.title}\nPage: ${savedPage.title}\nRevision: ${savedPage.revision}\nAssociation: ${document.association?.title ?? 'None'}\n\n${savedPage.markdown.slice(0, 8000)}${savedPage.markdown.length > 8000 ? '\n[Page truncated; use read_notebook_page for remaining text.]' : ''}`,
      writingNotebook: pageContext, at: new Date().toISOString()
    })
    let attached: ChatQuote | undefined
    const selected = typeof quote?.text === 'string' ? quote.text.trim().slice(0, MAX_QUOTE_CHARS) : ''
    if (selected && quote?.from === 'answer') attached = { text: selected, from: 'answer' }
    else if (selected && quote?.writingNotebook?.notebookId === document.id && quote.writingNotebook.pageId === page) {
      attached = { text: selected, from: 'writing-notebook', writingNotebook: pageContext }
    }
    const seq = appendWritingNotebookMessage(id, { role: 'user', text: asked, ...(attached ? { quote: attached } : {}), writingNotebook: pageContext, at: new Date().toISOString() })
    let answered = '', finalized = false
    const localSources: ReadingSource[] = [], citations: ChatCitation[] = []
    const logger = log.child('writing.chat', { userId: owner, data: { chatId: id, notebookId: document.id } })
    const finish = (status: 'complete' | 'stopped' | 'failed', error?: string): void => {
      if (finalized) return
      finalized = true; controller.abort()
      clearTimeout(timer); unbind()
      if (inflight.get(id) === entry) inflight.delete(id)
      try {
        if (valid() && answered.trim()) appendWritingNotebookMessage(id, { role: 'assistant', text: answered, status, writingNotebook: pageContext, localSources, citations, generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' }, at: new Date().toISOString() })
      } catch (saveError) { error = `Could not save the answer: ${(saveError as Error).message}` }
      if (error) push('error', scrubSecrets(error)); else push('done', { stopped: status === 'stopped' })
    }
    const timer = setTimeout(() => finish('failed', 'Notebook chat timed out. Ask a more focused question.'), 18 * 60_000)
    timer.unref(); entry.stop = () => finish('stopped')
    void generateChatTitle({ scope: 'writing-notebook', notebookId: document.id, chatId: id, owner, sender, key, provider: chat.provider ?? 'apiKey', model: chat.model, reasoningEfforts: conversationReasoning('chat', chat.model, chat.pinnedProvider) })
    const webSearch = readPreferences().webSearch === true && webSearchFor(chat.model, chat.reasoning)
    const instructions = `You are a helpful writing and learning companion beside a personal Markdown notebook in OpenCourse. The current saved page is supplied as context. Answer questions about it and use read-only tools for other pages or associated material. You cannot edit the notebook. Embedded image markup is not image analysis. ${READING_TOOL_INSTRUCTIONS}\n${webSearch ? 'Web search is available when external facts are needed; distinguish web information from notebook sources.' : 'You cannot search the web.'}\nWrite clear, concise Markdown.`
    const budget = { chars: 0, signal: controller.signal }
    const modelContext = conversationModelContext(chat.provider ?? 'apiKey', chat.model)
    setImmediate(() => { void (async () => {
      try {
        const result = await runChatAgent({ input: buildInput(selectWritingNotebookMessages(id), instructions),
          session: { mode: 'writing-notebook', chatId: id, turnSeq: seq, model: chat.model, provider: chat.provider ?? 'apiKey', key, tools, webSearch, sourceVersion: JSON.stringify(snapshot.map(p => [p.id, p.revision])),
            context: [{ role: 'user', content: `[notebook context]\n\n${selectWritingNotebookMessages(id).filter(m => m.role === 'context').at(-1)?.text ?? ''}` }], valid, sources: localSources },
          readOnly: () => true,
          signal: controller.signal, limits: READING_LIMITS,
          stream: async input => {
            const begin = answered.length
            let first = true
            const result = await streamChat({ key, provider: chat.provider, model: chat.model, modelContext, input, tools, toolNamespace: { name: 'notebook', description: 'Read-only retrieval from notebook pages and associated material.' }, webSearch, ...(chat.reasoning ? { reasoning: chat.reasoning } : {}), signal: controller.signal,
              onSearch: () => push('activity', 'Searching the web…'), onDelta: chunk => {
                if (finalized || !valid()) return
                const delta = first && answered ? `\n\n${chunk}` : chunk; first = false
                answered += delta; push('delta', delta)
              } })
            if (first && result.text && !finalized && valid()) {
              const delta = `${begin ? '\n\n' : ''}${result.text}`
              answered += delta; push('delta', delta)
            }
            const offset = begin + (begin && result.text ? 2 : 0)
            citations.push(...result.citations.map(citation => ({ ...citation, start: citation.start + offset, end: citation.end + offset })))
            return result
          }, tool: async (name, args) => {
            if (finalized || !valid()) throw new Error('Notebook chat stopped.')
            push('activity', name.startsWith('search_') ? 'Searching notebook sources…' : 'Reading notebook sources…')
            try { return runWritingReadingTool(document, snapshot, name, args, budget, localSources) }
            catch (error) { return JSON.stringify({ error: (error as Error).message }) }
          } })
        finish(result.stopped ? 'stopped' : 'complete')
      } catch (error) {
        logger.warn('Notebook chat failed', { message: scrubSecrets((error as Error).message) })
        finish(controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? undefined : (error as Error).message)
      }
    })() })
    return { status: 'ok', seq }
  } catch (error) {
    controller.abort(); inflight.delete(id); unbind(); throw error
  }
}
