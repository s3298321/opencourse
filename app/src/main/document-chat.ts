import { app, type WebContents } from 'electron'
import { newChatId } from '../core/sidechat/ids'
import { buildInput, MAX_MESSAGE_CHARS, MAX_QUOTE_CHARS } from '../core/sidechat/thread'
import { webSearchFor } from '../core/sidechat/models'
import { DOCUMENT_TOOLS, READING_LIMITS, READING_TOOL_INSTRUCTIONS } from '../core/reading/tools'
import { runProjectAgent } from '../core/projects/agent'
import { scrubSecrets } from '../core/coach/key'
import type { AIProvider, ChatCitation, ChatQuote, ChatSendResult, ReasoningEffort } from '../core/types'
import type { DocumentChatSummary, DocumentChatThread, ReadingSource } from '../core/documents/types'
import { conversationConfig, conversationModelContext, conversationReasoning, newAIConversation, pinnedConversation, prepareAIRequest, validateConversationModel } from './ai'
import { appendDocumentMessage, configureDocumentChat, deleteDocumentChatRow, insertDocumentChat, selectDocumentChat, selectDocumentChats, selectDocumentMessages } from './document-chatdb'
import { documentEvents, getDocument } from './documents'
import { runDocumentReadingTool } from './document-reading'
import { readPreferences } from './preferences'
import { currentUserId, requireUser } from './users'
import { streamChat } from './openai'
import { whenSenderGone } from './senders'
import { cancelChatTitles, generateChatTitle } from './chattitles'
import { iconsFor } from './favicons'
import { log } from './log'

interface Inflight { controller: AbortController; provider: AIProvider; documentId: string; chat?: DocumentChatSummary; stop?: () => void }
const inflight = new Map<string, Inflight>()
export function cancelDocumentChat(id: string): void {
  cancelChatTitles('document', { chatId: id })
  const entry = inflight.get(id); entry?.controller.abort(); entry?.stop?.()
}
export function cancelAllDocumentChats(provider?: AIProvider): void {
  cancelChatTitles('document', provider ? { provider } : {})
  for (const [id, entry] of inflight) if (!provider || entry.provider === provider) cancelDocumentChat(id)
}
documentEvents.on('removing', (id: string) => {
  for (const [chatId, entry] of inflight) if (entry.documentId === id) cancelDocumentChat(chatId)
  for (const chat of selectDocumentChats(id)) cancelChatTitles('document', { chatId: chat.id })
})
app.on('before-quit', () => cancelAllDocumentChats())
function requireChat(id: string): DocumentChatSummary {
  const chat = selectDocumentChat(id)
  if (!chat) throw new Error('This document chat no longer exists.')
  return chatConfig(chat)
}
function chatConfig(chat: DocumentChatSummary): DocumentChatSummary {
  const snapshot = inflight.get(chat.id)?.chat
  return snapshot ? { ...chat, model: snapshot.model, reasoning: snapshot.reasoning, provider: snapshot.provider } : conversationConfig('chat', chat)
}
export function listDocumentChats(id: string): DocumentChatSummary[] {
  getDocument(id)
  return selectDocumentChats(id).map(chatConfig)
}
export function getDocumentChat(id: string): DocumentChatThread | null {
  return selectDocumentChat(id) ? { chat: requireChat(id), messages: selectDocumentMessages(id) } : null
}
export function createDocumentChat(documentId: string, page: number): DocumentChatSummary {
  const document = getDocument(documentId)
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(1, document.pages)) throw new Error('Invalid document page.')
  const at = new Date().toISOString()
  const id = newChatId()
  insertDocumentChat({ id, documentId, startedOn: page, ...newAIConversation('chat'), title: '', messages: 0, createdAt: at, updatedAt: at })
  return requireChat(id)
}
function mutableChat(id: string): DocumentChatSummary {
  if (inflight.has(id)) throw new Error('Wait for the response before changing this chat.')
  return requireChat(id)
}
export function setDocumentChatModel(id: string, model: string): DocumentChatSummary {
  const chat = mutableChat(id)
  validateConversationModel('chat', model, undefined, chat.pinnedProvider)
  const reasoning = chat.reasoning && conversationReasoning('chat', model, chat.pinnedProvider).includes(chat.reasoning) ? chat.reasoning : null
  configureDocumentChat(id, model, reasoning, chat.provider ?? 'apiKey')
  return requireChat(id)
}
export function setDocumentChatReasoning(id: string, reasoning: ReasoningEffort | null): DocumentChatSummary {
  const chat = mutableChat(id)
  validateConversationModel('chat', chat.model, reasoning, chat.pinnedProvider)
  configureDocumentChat(id, chat.model, reasoning, chat.provider ?? 'apiKey')
  return requireChat(id)
}
export function setDocumentChatProvider(id: string, provider: AIProvider | null): DocumentChatSummary {
  mutableChat(id)
  const config = pinnedConversation('chat', provider)
  configureDocumentChat(id, config.model, config.reasoning, config.provider, config.pinned)
  return requireChat(id)
}
export function deleteDocumentChat(id: string): void { cancelDocumentChat(id); deleteDocumentChatRow(id) }
export async function documentSourceIcons(id: string, seq: number): Promise<Record<string, string | null>> {
  requireChat(id)
  const message = selectDocumentMessages(id).find(message => message.seq === seq)
  return iconsFor((message?.citations ?? []).flatMap(citation => { try { return [new URL(citation.url).hostname] } catch { return [] } }))
}
export async function sendDocumentMessage(sender: WebContents, id: string, text: string, quote: ChatQuote | undefined, page: number): Promise<ChatSendResult> {
  let chat = requireChat(id)
  const owner = requireUser(), asked = typeof text === 'string' ? text.trim().slice(0, MAX_MESSAGE_CHARS) : ''
  if (!asked) return { status: 'failed', message: 'There is nothing to ask.' }
  if (inflight.has(id)) return { status: 'busy' }
  const document = getDocument(chat.documentId)
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(document.pages, 1)) return { status: 'failed', message: 'Invalid document page.' }
  const controller = new AbortController(), entry: Inflight = { controller, provider: chat.provider ?? 'apiKey', documentId: chat.documentId }
  inflight.set(id, entry)
  const push = (channel: string, ...args: unknown[]): void => { if (!sender.isDestroyed() && currentUserId() === owner) sender.send(`documentChat:${channel}`, id, ...args) }
  const valid = (): boolean => currentUserId() === owner && !!selectDocumentChat(id)
  const unbind = whenSenderGone(sender, () => cancelDocumentChat(id))
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
    configureDocumentChat(id, chat.model, chat.reasoning, chat.provider ?? 'apiKey')
    const messages = selectDocumentMessages(id), previous = [...messages].reverse().find(message => message.role === 'context')
    if (previous?.document?.page !== page) appendDocumentMessage(id, { role: 'context', text: `Document: ${document.title}\nPages: ${document.pages || 'not yet known'}\nCurrently reading: page ${page}\nNo PDF text has been automatically included. Use the local document tools to retrieve relevant passages.`, document: { id: document.id, page }, at: new Date().toISOString() })
    let attached: ChatQuote | undefined
    const selected = typeof quote?.text === 'string' ? quote.text.trim().slice(0, MAX_QUOTE_CHARS) : ''
    if (selected && quote?.from === 'answer') attached = { text: selected, from: 'answer' }
    else if (selected && quote?.document?.id === document.id) {
      const quotedPage = quote.document.page
      // Quotes are user input; page references must belong to this document.
      if (Number.isSafeInteger(quotedPage) && quotedPage >= 1 && quotedPage <= Math.max(1, document.pages)) attached = { text: selected, from: 'document', document: { id: document.id, page: quotedPage } }
    }
    const seq = appendDocumentMessage(id, { role: 'user', text: asked, ...(attached ? { quote: attached } : {}), document: { id: document.id, page }, at: new Date().toISOString() })
    let answered = '', finalized = false
    const localSources: ReadingSource[] = [], citations: ChatCitation[] = []
    const logger = log.child('document.chat', { userId: owner, data: { chatId: id, documentId: document.id } })
    const finish = (status: 'complete' | 'stopped' | 'failed', error?: string): void => {
      if (finalized) return
      finalized = true; controller.abort()
      clearTimeout(timer); unbind()
      if (inflight.get(id) === entry) inflight.delete(id)
      try {
        if (valid() && answered.trim()) appendDocumentMessage(id, { role: 'assistant', text: answered, status, document: { id: document.id, page }, localSources, citations, generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' }, at: new Date().toISOString() })
      } catch (saveError) { error = `Could not save the answer: ${(saveError as Error).message}` }
      if (error) push('error', scrubSecrets(error)); else push('done', { stopped: status === 'stopped' })
    }
    const timer = setTimeout(() => finish('failed', 'Document Ask timed out. Ask a more focused question.'), 18 * 60_000)
    timer.unref(); entry.stop = () => finish('stopped')
    void generateChatTitle({ scope: 'document', documentId: document.id, chatId: id, owner, sender, key, provider: chat.provider ?? 'apiKey', model: chat.model, reasoningEfforts: conversationReasoning('chat', chat.model, chat.pinnedProvider) })
    const webSearch = readPreferences().webSearch === true && webSearchFor(chat.model, chat.reasoning)
    const instructions = `You are a helpful reading companion beside a local PDF in OpenCourse. Explain the document using its vocabulary. Answer the selected passage when quoted; expand only when asked. You receive the document identity and reading position, not its full text. ${READING_TOOL_INSTRUCTIONS}\n${webSearch ? 'Web search is available only when current external facts are needed. Distinguish web information from the document.' : 'You cannot search the web.'}\nWrite clear, concise markdown.`
    const budget = { chars: 0, signal: controller.signal }
    const modelContext = conversationModelContext(chat.provider ?? 'apiKey', chat.model)
    setImmediate(() => { void (async () => {
      try {
        const result = await runProjectAgent({ input: buildInput(selectDocumentMessages(id), instructions), signal: controller.signal, limits: READING_LIMITS,
          stream: async input => {
            const begin = answered.length
            let first = true
            const result = await streamChat({ key, provider: chat.provider, model: chat.model, modelContext, input, tools: DOCUMENT_TOOLS, toolNamespace: { name: 'document', description: 'Read-only retrieval from the current local PDF.' }, webSearch, ...(chat.reasoning ? { reasoning: chat.reasoning } : {}), signal: controller.signal,
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
            if (finalized || !valid()) throw new Error('Document Ask stopped.')
            push('activity', name === 'search_document' ? 'Searching the document…' : name === 'read_document_pages' ? 'Reading document pages…' : 'Listing document sections…')
            try { return runDocumentReadingTool(document.id, name, args, budget, localSources) }
            catch (error) { return JSON.stringify({ error: (error as Error).message }) }
          } })
        finish(result.stopped ? 'stopped' : 'complete')
      } catch (error) {
        logger.warn('Document Ask failed', { message: scrubSecrets((error as Error).message) })
        finish(controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? undefined : (error as Error).message)
      }
    })() })
    return { status: 'ok', seq }
  } catch (error) {
    controller.abort(); inflight.delete(id); unbind(); throw error
  }
}

