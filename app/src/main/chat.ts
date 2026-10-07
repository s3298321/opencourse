import { assertCourseAvailable } from './course-busy'
import { createHash } from 'node:crypto'
/**
 * Side chat: a text conversation about the lesson the learner is reading.
 *
 * Three rules, all inherited from Coach and all load-bearing.
 *
 * **The key never crosses to the renderer.** `readKey()` is called here and the
 * value goes straight to openai.ts. Nothing this module returns carries it, and
 * the errors that do come back have been through `scrubSecrets`.
 *
 * **A chat's course comes from its row, never from an argument.** The renderer
 * hands over a chat id; `selectChat` says which course that is, and
 * `requireUser()` - inside db() - says whose. A renderer cannot aim a message at
 * another course, let alone another user.
 *
 * **The renderer never sends the lesson text, only its coordinates.** The
 * context is built here from the manifest on disk, with quiz answers and
 * exercise solutions stripped by `lessonContextText`. The renderer could not
 * send a faithful lesson if it wanted to - the CourseView it holds has those
 * fields removed already - and it should not be trusted to say what the model
 * was told in any case.
 */
import type { WebContents } from 'electron'
import { app } from 'electron'
import { findLesson } from '../core/manifest'
import { lessonContextText } from '../core/sidechat/context'
import { newChatId } from '../core/sidechat/ids'
import { newChatDefaults, normalizeChatModels } from '../core/preferences'
import {
  filterChatModels,
  isChatModelId,
  offeredModels,
  reasoningEffortsFor,
  webSearchFor
} from '../core/sidechat/models'
import { sideChatInstructions } from '../core/sidechat/prompt'
import { MAX_MESSAGE_CHARS, MAX_QUOTE_CHARS, buildInput, needsContext } from '../core/sidechat/thread'
import type {
  ChatLessonRef,
  ChatDefaults,
  ChatModel,
  ChatModelSettings,
  ChatPickerModels,
  ChatQuote,
  ChatSendResult,
  ChatSummary,
  ChatThread,
  ReasoningEffort
} from '../core/types'
import {
  appendMessage,
  deleteChatRow,
  insertChat,
  selectChat,
  selectChats,
  selectMessageCitations,
  selectMessages,
  updateChatModel
} from './chatdb'
import { readKey } from './coachkey'
import { getCourse } from './courses'
import { iconsFor } from './favicons'
import { OpenAIError, listChatModels, streamChat, type ChatSearchEvent } from './openai'
import { readPreferences, writePreferences } from './preferences'
import { conversationConfig, conversationReasoning, newAIConversation, prepareAIRequest, profileFor, validateConversationModel } from './ai'
import { aiPickerModels, getAIModelSettings, notifyAIChanged } from './ai'
import { aiSettings, profileDefaults } from '../core/ai'
import { requireUser, currentUserId } from './users'
import { cancelChatTitles, generateChatTitle } from './chattitles'
import { log } from './log'

/**
 * One answer in flight per chat, so a learner hammering Send cannot open four
 * billable requests against the same conversation. Keyed by chat id, and the
 * value is what cancels it - plus which renderer is waiting, so a window that
 * goes away takes its requests with it.
 */
const inflight = new Map<string, { controller: AbortController; senderId: number; chat: ChatSummary; stop?: () => void }>()
const preparing = new Map<string, { controller: AbortController; senderId: number; provider: import('../core/types').AIProvider }>()

/** Senders already bound, so a second question does not add a second listener. */
const watched = new WeakSet<WebContents>()

/**
 * A closed or reloaded window is not waiting for an answer, and an answer
 * nobody will read is still billed for. Same teardown discipline as a coaching
 * session, and as pty.ts before that.
 */
function watchSender(sender: WebContents): void {
  if (watched.has(sender)) return
  watched.add(sender)
  const drop = (): void => cancelForSender(sender.id)
  sender.once('destroyed', drop)
  sender.on('render-process-gone', drop)
  sender.on('did-start-navigation', (event) => {
    if (event.isMainFrame && event.isSameDocument === false) drop()
  })
}

/** Everything this renderer was waiting on. Whatever streamed is still kept. */
export function cancelForSender(senderId: number): void {
  cancelChatTitles('chat', { senderId })
  for (const entry of preparing.values()) if (entry.senderId === senderId) entry.controller.abort()
  for (const [chatId, entry] of inflight) {
    if (entry.senderId === senderId) {
      entry.controller.abort()
      inflight.delete(chatId)
    }
  }
}

export function isAnswering(chatId: string): boolean {
  return inflight.has(chatId) || preparing.has(chatId)
}

export function cancelChat(chatId: string): void {
  cancelChatTitles('chat', { chatId })
  preparing.get(chatId)?.controller.abort()
  inflight.get(chatId)?.controller.abort()
}

export function cancelCourseChats(courseId: string): void {
  cancelChatTitles('chat', { courseId })
  for (const chat of selectChats(courseId)) {
    const active = inflight.get(chat.id)
    cancelChat(chat.id)
    active?.stop?.()
  }
}

/** A renderer that navigated or quit is not waiting for an answer any more. */
export function cancelAllChats(provider?: import('../core/types').AIProvider): void {
  cancelChatTitles('chat', provider ? { provider } : {})
  for (const entry of preparing.values()) if (!provider || entry.provider === provider) entry.controller.abort()
  for (const entry of inflight.values()) if (!provider || entry.chat.provider === provider) entry.controller.abort()
}

app.on('before-quit', () => cancelAllChats())

function requireChat(chatId: string): ChatSummary {
  const chat = selectChat(chatId)
  if (!chat) throw new Error('that chat does not exist')
  return chatConfig(chat)
}

function chatConfig(chat: ChatSummary): ChatSummary {
  const snapshot = inflight.get(chat.id)?.chat
  const configured = snapshot ? { ...chat, model: snapshot.model, reasoning: snapshot.reasoning, provider: snapshot.provider } : conversationConfig('chat', chat)
  const course = getCourse(chat.courseId)
  return { ...configured, historyLabel: chat.startedIn && course ? findLesson(course, chat.startedIn.moduleId, chat.startedIn.lessonId)?.lesson.title ?? 'Conversation' : 'Conversation' }
}

export function listChats(courseId: string): ChatSummary[] {
  return selectChats(courseId).map(chatConfig)
}

export function getChat(chatId: string): ChatThread | null {
  const chat = selectChat(chatId)
  return chat ? { chat: requireChat(chatId), messages: selectMessages(chatId) } : null
}

/**
 * A new chat is a row and nothing else. The lesson it was started in is not
 * injected until the first message - a chat opened and abandoned should cost
 * nothing, and the learner may well scroll to another lesson before typing.
 */
export function createChat(courseId: string, lesson: ChatLessonRef, model?: string): ChatSummary {
  assertCourseAvailable(courseId)
  const course = getCourse(courseId)
  if (!course || !findLesson(course, lesson.moduleId, lesson.lessonId)) throw new Error('That lesson is not in this course.')
  const id = newChatId()
  const defaults = newAIConversation('chat')
  if (model) {
    validateConversationModel('chat', model)
    defaults.model = model
    if (defaults.reasoning && !conversationReasoning('chat', model).includes(defaults.reasoning)) defaults.reasoning = null
  }
  insertChat({
    id,
    courseId,
    ...defaults,
    startedIn: lesson,
    at: new Date().toISOString()
  })
  return requireChat(id)
}

export function setChatModel(chatId: string, model: string): ChatSummary {
  if (isAnswering(chatId)) throw new Error('Wait for the current response before changing its model.')
  const chat = requireChat(chatId)
  validateConversationModel('chat', model)
  // A level the new model cannot take would turn the next question into a 400,
  // so it goes back to the model's own default rather than coming along.
  const reasoning = chat.reasoning && conversationReasoning('chat', model).includes(chat.reasoning) ? chat.reasoning : null
  updateChatModel(chatId, model, reasoning, chat.provider)
  return requireChat(chatId)
}

/** Null is the model's own default. Anything else has to be a level this chat's model takes. */
export function setChatReasoning(chatId: string, reasoning: ReasoningEffort | null): ChatSummary {
  if (isAnswering(chatId)) throw new Error('Wait for the current response before changing its reasoning.')
  const chat = requireChat(chatId)
  validateConversationModel('chat', chat.model, reasoning)
  updateChatModel(chatId, chat.model, reasoning, chat.provider)
  return requireChat(chatId)
}

/* --- which models are offered ---------------------------------------------- */

/**
 * A smoke or screenshot run has no key, so OpenAI never lists a model for it,
 * and the one screen that needs a real list - choosing models in Settings -
 * could only ever show its no-key note there. Those runs get a fixed list in
 * the API's shape instead; nothing else ever reads it.
 */
const HEADLESS_MODEL_IDS = ['gpt-5.6-terra', 'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'gpt-4.1', 'o4-mini']

async function reachableModels(): Promise<{ models: ChatModel[]; source: 'api' | 'fallback'; error?: string }> {
  if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) {
    return { models: filterChatModels(HEADLESS_MODEL_IDS), source: 'api' }
  }
  return listChatModels(readKey())
}

/** The picker's list: what the key reaches, narrowed to what Settings left on. */
export async function listPickerModels(): Promise<ChatPickerModels> {
  if (readPreferences().ai) return aiPickerModels('chat')
  const list = await reachableModels()
  const preferences = readPreferences()
  return {
    ...list,
    models: offeredModels(list.models, preferences.chatModels ?? null),
    webSearch: preferences.webSearch === true
  }
}

export async function getChatModelSettings(): Promise<ChatModelSettings> {
  const preferences = readPreferences()
  if (preferences.ai) {
    const settings = await getAIModelSettings('chat', 'apiKey')
    return { models: settings.models, source: settings.source === 'api' ? 'api' : 'fallback', error: settings.error,
      enabled: settings.profile.enabledModels, defaults: profileDefaults(settings.profile), webSearch: settings.webSearch }
  }
  return { ...(await reachableModels()), enabled: preferences.chatModels ?? null, defaults: newChatDefaults(preferences), webSearch: preferences.webSearch === true }
}

export function setChatDefaults(defaults: ChatDefaults): ChatDefaults {
  const preferences = readPreferences()
  if (preferences.ai) {
    const settings = aiSettings(preferences), profile = settings.chat.profiles.apiKey
    if (!isChatModelId(defaults.model) || (profile.enabledModels !== null && !profile.enabledModels.includes(defaults.model))) throw new Error('Choose an allowed chat model.')
    if (defaults.reasoning && !reasoningEffortsFor(defaults.model).includes(defaults.reasoning)) throw new Error('That reasoning level is unavailable.')
    settings.chat.profiles.apiKey = { ...profile, defaultModel: defaults.model, defaultReasoning: defaults.reasoning }
    writePreferences({ ...preferences, ai: settings }); notifyAIChanged()
    return defaults
  }
  if (!defaults || typeof defaults.model !== 'string' || defaults.model.length > 100 || !isChatModelId(defaults.model)) {
    throw new Error('Choose a chat model.')
  }
  if (preferences.chatModels && !preferences.chatModels.includes(defaults.model)) {
    throw new Error('Enable this model before choosing it as the default.')
  }
  if (defaults.reasoning !== null && !reasoningEffortsFor(defaults.model).includes(defaults.reasoning)) {
    throw new Error('That reasoning level is unavailable for this model.')
  }
  const { defaultChatReasoning: _previous, ...rest } = preferences
  return newChatDefaults(writePreferences({
    ...rest,
    defaultChatModel: defaults.model,
    ...(defaults.reasoning !== null ? { defaultChatReasoning: defaults.reasoning } : {})
  }))
}

/**
 * Which models the picker offers. Null goes back to all of them. A list is
 * kept the way the file is read, and refused if nothing in it survives: an
 * empty picker is a chat nobody can use, and that is not a choice to store.
 */
export function setEnabledChatModels(ids: string[] | null): string[] | null {
  const preferences = readPreferences()
  if (preferences.ai) {
    const kept = ids === null ? null : normalizeChatModels(ids)
    if (ids !== null && !kept) throw new Error('Keep at least one model on.')
    const settings = aiSettings(preferences), profile = settings.chat.profiles.apiKey
    const model = !kept || (profile.defaultModel && kept.includes(profile.defaultModel)) ? profile.defaultModel : kept[0]
    settings.chat.profiles.apiKey = { ...profile, enabledModels: kept, defaultModel: model,
      defaultReasoning: model === profile.defaultModel ? profile.defaultReasoning : null }
    writePreferences({ ...preferences, ai: settings }); notifyAIChanged()
    return kept
  }
  const { chatModels: _previous, ...rest } = readPreferences()
  if (ids === null) {
    writePreferences(rest)
    return null
  }
  const kept = normalizeChatModels(ids)
  if (!kept) throw new Error('keep at least one model on')
  writePreferences({ ...rest, chatModels: kept })
  return kept
}

export function getChatWebSearch(): boolean {
  return readPreferences().webSearch === true
}

/**
 * Lets the side chat search the web, or stops it. Stored as an absence when
 * off, so the file only ever says yes when someone said yes.
 */
export function setChatWebSearch(on: boolean): boolean {
  const { webSearch: _previous, ...rest } = readPreferences()
  writePreferences(on === true ? { ...rest, webSearch: true } : rest)
  return readPreferences().webSearch === true
}

/**
 * The favicons of the pages one answer cited, keyed by host name. The hosts
 * come from that answer's stored row: the renderer names a message, never a
 * site, so it cannot point main's fetcher anywhere an answer did not.
 */
export async function getSourceIcons(chatId: string, seq: number): Promise<Record<string, string | null>> {
  requireChat(chatId)
  if (!Number.isInteger(seq)) return {}
  const hosts: string[] = []
  for (const citation of selectMessageCitations(chatId, seq)) {
    try {
      hosts.push(new URL(citation.url).hostname)
    } catch {
      // normalizeCitations already refused it; nothing to look up.
    }
  }
  return iconsFor(hosts)
}

/** What the activity line under a searching answer says. */
function searchActivity(event: ChatSearchEvent): string {
  if (event.state === 'running') return 'Searching the web…'
  return event.query ? `Searched the web for “${event.query}”` : 'Searched the web'
}

/**
 * The 400 a model gives when it does not take the web search tool. Narrow on
 * purpose: retrying any other 400 without the tool would hide a real error
 * behind a second identical one.
 */
function refusedSearch(err: unknown): boolean {
  return err instanceof OpenAIError && err.status === 400 && /web_search|tool/i.test(err.message)
}

export function deleteChat(chatId: string): void {
  cancelChat(chatId)
  deleteChatRow(chatId)
}

/** A renderer that went away must not be written to; main/ipc.ts has the same guard. */
function push(sender: WebContents, channel: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

/**
 * Asks a question and streams the answer back to the renderer that asked.
 *
 * Returns as soon as the question is stored, because the answer arrives on
 * `chat:delta` / `chat:done` / `chat:error` rather than on this promise - a
 * renderer waiting on an invoke for a minute is a renderer that cannot show a
 * Stop button.
 */
export async function sendChatMessage(
  sender: WebContents,
  chatId: string,
  text: string,
  quote: ChatQuote | undefined,
  lesson: ChatLessonRef
): Promise<ChatSendResult> {
  let chat = requireChat(chatId)
  const owner = requireUser()
  const asked = String(text ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
  if (!asked) return { status: 'failed', message: 'there is nothing to ask' }
  if (isAnswering(chatId)) return { status: 'busy' }

  if (profileFor('chat').provider === 'apiKey' && !readKey()) return { status: 'no-key' }
  let key: string
  const preparation = new AbortController()
  watchSender(sender)
  preparing.set(chatId, { controller: preparation, senderId: sender.id, provider: chat.provider ?? 'apiKey' })
  const logger = log.child('chat', { userId: owner, data: { chatId, courseId: chat.courseId } })
  try { ({ chat, key } = await prepareAIRequest('chat', chat, preparation.signal)) }
  catch (error) {
    if (preparation.signal.aborted) return { status: 'failed', message: 'Message stopped before sending.' }
    logger.warn('The connection was not ready for a question', { provider: chat.provider ?? 'apiKey', message: (error as Error).message })
    return { status: 'connection-required', provider: chat.provider ?? 'apiKey', message: (error as Error).message }
  }
  finally { preparing.delete(chatId) }
  if (preparation.signal.aborted) return { status: 'failed', message: 'Message stopped before sending.' }
  if (currentUserId() !== owner) return { status: 'failed', message: 'The local user changed.' }
  if (inflight.has(chatId)) return { status: 'busy' }
  updateChatModel(chatId, chat.model, chat.reasoning, chat.provider)

  // The course comes from the chat's own row, never from the caller.
  assertCourseAvailable(chat.courseId)
  const course = getCourse(chat.courseId)
  if (!course) return { status: 'failed', message: `that course is no longer in your library` }
  const found = findLesson(course, lesson.moduleId, lesson.lessonId)
  if (!found) return { status: 'failed', message: 'that lesson is not in this course' }

  const at = new Date().toISOString()
  const stored = selectMessages(chatId)
  const contextText = lessonContextText(course.title, found.module.title, found.lesson, course.subject)
  const contextFingerprint = createHash('sha256').update(contextText).digest('hex')
  if (needsContext(stored, lesson, contextFingerprint)) {
    appendMessage(chatId, {
      role: 'context',
      text: contextText,
      contextFingerprint,
      lesson,
      at
    })
  }

  // Rebuilt rather than stored as given: it arrived over IPC, and anything but
  // 'answer' is a passage from the lesson, which is what a quote always was.
  const quoted = typeof quote?.text === 'string' ? quote.text.trim().slice(0, MAX_QUOTE_CHARS) : ''
  const seq = appendMessage(chatId, {
    role: 'user',
    text: asked,
    ...(quoted ? { quote: { text: quoted, from: quote?.from === 'answer' ? 'answer' : 'lesson' } } : {}),
    lesson,
    at
  })

  const controller = new AbortController()
  const titleReasoning = conversationReasoning('chat', chat.model)
  const started = Date.now()
  const about = (): Record<string, unknown> => ({ model: chat.model, provider: chat.provider ?? 'apiKey', reasoning: chat.reasoning ?? null, ms: Date.now() - started, chars: answered.length })
  let answered = ''
  let finalized = false
  const valid = (): boolean => currentUserId() === owner && !!selectChat(chatId) && getCourse(chat.courseId)?.revision === course.revision
  const stop = (): void => {
    if (finalized) return
    finalized = true
    controller.abort()
    if (inflight.get(chatId)?.controller === controller) inflight.delete(chatId)
    if (valid() && answered.trim()) appendMessage(chatId, { role: 'assistant', text: answered, status: 'stopped', generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' }, lesson, at: new Date().toISOString() })
    logger.info('Answer stopped', about())
    push(sender, 'chat:done', chatId, { stopped: true })
  }
  inflight.set(chatId, { controller, senderId: sender.id, chat, stop })
  watchSender(sender)

  // Search is offered when Settings allows it and the model can take it; the
  // model then decides, question by question, whether to use it.
  const webSearch = readPreferences().webSearch === true && webSearchFor(chat.model, chat.reasoning)

  void (async () => {
    const ask = (search: boolean): ReturnType<typeof streamChat> =>
      streamChat({
        key,
        provider: chat.provider,
        model: chat.model,
        ...(chat.reasoning ? { reasoning: chat.reasoning } : {}),
        input: buildInput(selectMessages(chatId), sideChatInstructions(search)),
        webSearch: search,
        onSearch: (event) => { if (!finalized && valid()) push(sender, 'chat:activity', chatId, searchActivity(event)) },
        signal: controller.signal,
        onDelta: (chunk) => {
          if (finalized || !valid()) return
          answered += chunk
          push(sender, 'chat:delta', chatId, chunk)
        }
      })
    try {
      let result: Awaited<ReturnType<typeof streamChat>>
      try {
        result = await ask(webSearch)
      } catch (err) {
        // `webSearchFor` is a guess from the model's id. When it guessed wrong,
        // OpenAI refuses before a word is written and nothing is billed, so the
        // question goes again without the tool rather than failing outright.
        if (!webSearch || answered || !refusedSearch(err)) throw err
        logger.warn('The model refused web search; asking again without it', { model: chat.model, reasoning: chat.reasoning ?? null })
        result = await ask(false)
      }
      if (finalized || !valid()) return
      answered = result.text
      // Whatever arrived is kept, including a stopped answer: half an
      // explanation is worth more than a gap in the transcript.
      if (currentUserId() === owner && answered.trim() && selectChat(chatId) && getCourse(chat.courseId)?.revision === course.revision) {
        appendMessage(chatId, {
          role: 'assistant',
          text: answered,
          status: result.aborted ? 'stopped' : 'complete',
          generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' },
          ...(result.citations.length ? { citations: result.citations } : {}),
          lesson,
          at: new Date().toISOString()
        })
      }
      logger.info(result.aborted ? 'Answer stopped' : 'Answer complete', { ...about(), webSearch, citations: result.citations.length })
      push(sender, 'chat:done', chatId, { stopped: result.aborted })
      if (!result.aborted && answered.trim() && !controller.signal.aborted) void generateChatTitle({
        scope: 'chat', chatId, courseId: chat.courseId, owner, sender,
        key, provider: chat.provider ?? 'apiKey', model: chat.model, reasoningEfforts: titleReasoning,
        prompt: asked, response: answered
      })
    } catch (err) {
      if (finalized || !valid()) return
      // Keeping the partial must not cost the error report. By the time a
      // stream fails the user may have been switched or deleted, and then this
      // write throws too - out of a catch block, past the finally, and into an
      // unhandled rejection in main.
      try {
        if (currentUserId() === owner && answered.trim() && selectChat(chatId) && getCourse(chat.courseId)?.revision === course.revision) {
          appendMessage(chatId, { role: 'assistant', text: answered, status: 'failed', generation: { model: chat.model, reasoning: chat.reasoning, provider: chat.provider ?? 'apiKey' }, lesson, at: new Date().toISOString() })
        }
      } catch {
        // Nothing left to save it to; the error below is the thing to report.
      }
      logger.error('Answer failed', { ...about(), webSearch, error: err })
      push(sender, 'chat:error', chatId, (err as Error).message)
    } finally {
      if (inflight.get(chatId)?.controller === controller) inflight.delete(chatId)
    }
  })()

  return { status: 'ok', seq }
}
