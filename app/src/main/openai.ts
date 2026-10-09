import type { ResponseInput } from '../core/projects/agent'
import { responseRequest, subscriptionModels } from '../core/ai-request'
import type { AIProvider, ModelContextMetadata } from '../core/types'
/**
 * Everything the app says to OpenAI. The other network calls are favicons.ts,
 * which fetches the icons of pages a side chat answer cited, server requests
 * (serverclient.ts) and, when asked, the app's own update check and download
 * (updates.ts).
 *
 * It lives in main, and it stays in main: the renderer's CSP is
 * `connect-src 'self'` and nothing here should make anyone want to widen it.
 * Uses Electron's `net.fetch` rather than Node's, so requests follow the
 * system proxy and the app's own session - the same stack protocol.ts uses.
 *
 * Every error that leaves this module goes through `scrubSecrets`. OpenAI's
 * error bodies quote the key they rejected, and those messages are shown to
 * the user.
 */
import { net } from 'electron'
import { scrubSecrets } from '../core/coach/key'
import { CHATGPT_USAGE_LIMIT, describeStreamFailure, resetHint, type StreamFailure } from '../core/ai-errors'
import { log } from './log'
import { REALTIME_MODELS, WEB_SEARCH_MODEL, filterRealtimeModels } from '../core/coach/models'
import { COACH_TURN_DETECTION } from '../core/coach/audio'
import { CHAT_MODELS, filterChatModels } from '../core/sidechat/models'
import type { ChatCitation, ChatModel, CoachModel, ReasoningEffort } from '../core/types'

const BASE = 'https://api.openai.com/v1'

/** Long enough for a cold model list, short enough not to hang a dialog. */
const TIMEOUT_MS = 20_000

/** A search runs while the coach is still talking, so it cannot run long. */
export const WEB_SEARCH_TIMEOUT_MS = 20_000

const logger = log.child('openai')

/** How much of a failure event the log keeps - enough to read its shape, not a transcript. */
const MAX_LOGGED_EVENT = 4000

export class OpenAIError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(scrubSecrets(message))
    this.name = 'OpenAIError'
    this.status = status
  }
}

/** OpenAI reports failures two ways; this reads both without trusting either. */
function messageFrom(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message) return message
  } catch {
    /* not JSON; fall through to the raw body */
  }
  const trimmed = body.trim().slice(0, 300)
  return trimmed || `OpenAI returned ${status}`
}

/** The `error` object of an error body, when there is one - for a usage limit's reset time. */
function errorObjectFrom(body: string): Record<string, unknown> | null {
  try {
    const error = (JSON.parse(body) as { error?: unknown }).error
    return error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface RequestOptions {
  key: string
  method?: 'GET' | 'POST'
  body?: string
  contentType?: string
  accept?: string
  timeoutMs?: number
}

async function request(path: string, options: RequestOptions): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
  const started = Date.now()
  // The path without its query: realtime calls carry the model there, which is
  // worth keeping, but nothing else ever should be.
  const endpoint = path.split('?')[0]
  try {
    const response = await net.fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${options.key}`,
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
        ...(options.accept ? { Accept: options.accept } : {})
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      const error = new OpenAIError(response.status, messageFrom(response.status, text))
      logger.warn('OpenAI refused a request', { endpoint, status: response.status, message: error.message, ms: Date.now() - started })
      throw error
    }
    return text
  } catch (err) {
    if (err instanceof OpenAIError) throw err
    if (controller.signal.aborted) {
      logger.warn('OpenAI did not answer in time', { endpoint, ms: Date.now() - started })
      throw new OpenAIError(0, 'OpenAI did not answer in time')
    }
    // A DNS failure or a dropped connection. The message can carry a URL with
    // credentials in pathological cases, so it is scrubbed like everything else.
    const error = new OpenAIError(0, scrubSecrets((err as Error).message || 'could not reach OpenAI'))
    logger.warn('Could not reach OpenAI', { endpoint, message: error.message, ms: Date.now() - started })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Doubles as the key check: a 200 here means the key works, and the body is
 * the model list the picker needs. Validating a key and filling the dropdown
 * are one round trip, deliberately.
 */
export async function listModelIds(key: string): Promise<string[]> {
  const body = await request('/models', { key })
  const parsed = JSON.parse(body) as { data?: unknown }
  if (!Array.isArray(parsed.data)) return []
  return parsed.data
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string')
}

export async function listSubscriptionModels(token: string): Promise<ChatModel[]> {
  return subscriptionModels(JSON.parse(await request('/models', { key: token })))
}

export interface ModelList {
  models: CoachModel[]
  source: 'api' | 'fallback'
  error?: string
}

/**
 * What the picker shows. A failed call is not an error here: an offline machine
 * should still offer a working choice rather than an empty dropdown, and the
 * curated list is what it falls back to.
 */
export async function listRealtimeModels(key: string): Promise<ModelList> {
  if (!key) return { models: [...REALTIME_MODELS], source: 'fallback' }
  try {
    const found = filterRealtimeModels(await listModelIds(key))
    if (!found.length) return { models: [...REALTIME_MODELS], source: 'fallback' }
    return { models: found, source: 'api' }
  } catch (err) {
    return { models: [...REALTIME_MODELS], source: 'fallback', error: (err as Error).message }
  }
}

/** The check coachkey.ts injects: does OpenAI accept this key at all? */
export async function validateKey(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await listModelIds(key)
    return { ok: true }
  } catch (err) {
    const error = err as OpenAIError
    if (error.status === 401) return { ok: false, message: 'OpenAI rejected that key.' }
    if (error.status === 403) return { ok: false, message: 'That key is not allowed to list models.' }
    return { ok: false, message: error.message }
  }
}

/* --- web search ------------------------------------------------------------ */

/** Enough for the coach to read out; not enough to derail the conversation. */
const MAX_ANSWER_CHARS = 3000
const MAX_CITATIONS = 5

export interface WebSearchResult {
  answer: string
  citations: { title: string; url: string }[]
}

/**
 * Walks the Responses API output for the text and the URL citations.
 *
 * Deliberately shape-tolerant: it looks for the pieces wherever they are rather
 * than asserting a layout, so a reshuffled response degrades to a shorter
 * answer instead of an exception mid-conversation.
 */
function readResponsesBody(body: string): WebSearchResult {
  const parsed = JSON.parse(body) as Record<string, unknown>
  const texts: string[] = []
  const citations: { title: string; url: string }[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>

    if (record['type'] === 'output_text' && typeof record['text'] === 'string') texts.push(record['text'])
    if (typeof record['url'] === 'string' && String(record['type'] ?? '').includes('citation')) {
      const url = record['url']
      if (!seen.has(url)) {
        seen.add(url)
        citations.push({ title: typeof record['title'] === 'string' ? record['title'] : url, url })
      }
    }
    for (const value of Object.values(record)) visit(value, depth + 1)
  }

  // The SDK's convenience field, when it is there; the walk otherwise.
  if (typeof parsed['output_text'] === 'string' && parsed['output_text']) texts.push(parsed['output_text'])
  visit(parsed['output'], 0)

  const answer = [...new Set(texts)].join('\n').trim().slice(0, MAX_ANSWER_CHARS)
  return { answer: answer || 'the search came back with nothing', citations: citations.slice(0, MAX_CITATIONS) }
}

/**
 * The coach's `web_search` tool. The Realtime API has no built-in web search,
 * so it is a function tool that main fulfils here, with the same key.
 */
export async function webSearch(
  key: string,
  query: string,
  options: { recencyDays?: number; timeoutMs?: number } = {}
): Promise<WebSearchResult> {
  const recency = options.recencyDays
    ? `\n\nOnly use sources from the last ${options.recencyDays} days.`
    : ''
  const body = JSON.stringify({
    model: WEB_SEARCH_MODEL,
    input:
      `Search the web and answer this concisely, for someone who will hear it read aloud ` +
      `in the middle of a conversation. A few sentences at most.\n\n${query}${recency}`,
    tools: [{ type: 'web_search' }]
  })

  const text = await request('/responses', {
    key,
    method: 'POST',
    body,
    contentType: 'application/json',
    timeoutMs: options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS
  })
  return readResponsesBody(text)
}

/* --- the realtime session -------------------------------------------------- */

export interface ClientSecret {
  value: string
  /** Unix seconds, as OpenAI reports it. Used to decide whether to re-mint. */
  expiresAt: number
}

export interface RealtimeSessionConfig {
  model: string
  voice: string
  instructions: string
  tools: unknown[]
}

/**
 * Mints the short-lived secret that authorises one call.
 *
 * The session's whole configuration - model, voice, instructions, tools, how
 * the learner's speech gets transcribed - is attached here, so the connection
 * is already the right shape before a single byte of audio moves.
 */
export async function mintClientSecret(key: string, config: RealtimeSessionConfig): Promise<ClientSecret> {
  const body = JSON.stringify({
    session: {
      type: 'realtime',
      model: config.model,
      instructions: config.instructions,
      tools: config.tools,
      tool_choice: 'auto',
      audio: {
        input: {
          // Without this there is no transcript of the learner's own speech,
          // and half the conversation never reaches the database.
          transcription: { model: 'gpt-4o-mini-transcribe' },
          noise_reduction: { type: 'far_field' },
          // Semantic VAD gives the learner time to finish, and lets them
          // interrupt naturally without waiting for a transcript round trip.
          turn_detection: COACH_TURN_DETECTION
        },
        output: { voice: config.voice }
      }
    }
  })

  const text = await request('/realtime/client_secrets', {
    key,
    method: 'POST',
    body,
    contentType: 'application/json'
  })
  const parsed = JSON.parse(text) as { value?: unknown; expires_at?: unknown }
  const value = typeof parsed.value === 'string' ? parsed.value : ''
  if (!value) throw new OpenAIError(0, 'OpenAI did not return a client secret')
  return {
    value,
    expiresAt: typeof parsed.expires_at === 'number' ? parsed.expires_at : Math.floor(Date.now() / 1000) + 60
  }
}

/**
 * Trades the renderer's SDP offer for OpenAI's answer.
 *
 * This runs in main so the renderer never holds a credential at all - not even
 * the short-lived one. The media path is unaffected: audio still flows directly
 * between the renderer and OpenAI over WebRTC, which is not something CSP
 * governs. `connect-src 'self'` stays as it is.
 */
export async function exchangeSdp(secret: string, offerSdp: string, model: string): Promise<string> {
  const answer = await request(`/realtime/calls?model=${encodeURIComponent(model)}`, {
    key: secret,
    method: 'POST',
    body: offerSdp,
    contentType: 'application/sdp',
    accept: 'application/sdp',
    timeoutMs: 30_000
  })
  if (!answer.includes('v=0')) throw new OpenAIError(0, 'OpenAI returned something that is not an SDP answer')
  return answer
}

/* --- the side chat --------------------------------------------------------- */

/**
 * What the picker shows. Same arrangement as listRealtimeModels: a failed call
 * is not an error, because an offline machine should still offer a working
 * choice rather than an empty dropdown.
 */
export async function listChatModels(key: string): Promise<{
  models: ChatModel[]
  source: 'api' | 'fallback'
  error?: string
}> {
  if (!key) return { models: [...CHAT_MODELS], source: 'fallback' }
  try {
    const found = filterChatModels(await listModelIds(key))
    if (!found.length) return { models: [...CHAT_MODELS], source: 'fallback' }
    return { models: found, source: 'api' }
  } catch (err) {
    return { models: [...CHAT_MODELS], source: 'fallback', error: (err as Error).message }
  }
}

/**
 * Abort when nothing has arrived for this long.
 *
 * Deliberately idle-based rather than total: a thorough answer to a hard
 * question legitimately takes a minute to finish, and a wall-clock timeout
 * would cut exactly the answers worth waiting for. What is not legitimate is
 * silence, so that is what is measured.
 */
export const STREAM_IDLE_MS = 60_000

/** The backstop, for a server that streams a byte a minute forever. */
export const STREAM_MAX_MS = 10 * 60_000

/**
 * How long a stream may stay silent before its first word.
 *
 * A reasoning model thinks before it writes, and the stream carries nothing
 * while it does - so the idle rule above, applied from the first byte, would
 * cut off exactly the answers someone asked to be thought about hardest. Once
 * text is flowing, silence means what it always meant. The model's own default
 * keeps the old rule, because that is what it has always run under.
 */
export function silenceBeforeAnswerMs(reasoning: ReasoningEffort | undefined): number {
  // Web search needs no allowance of its own: a search reports itself as it
  // goes (in progress, searching, completed), and every one of those events
  // is a byte on the stream that re-arms the idle timer. A search is never
  // silence, however many of them an answer runs.
  if (reasoning === 'medium') return 2 * 60_000
  if (reasoning === 'high') return 5 * 60_000
  if (reasoning === 'xhigh') return 8 * 60_000
  return STREAM_IDLE_MS
}

/**
 * Pulls the text out of one Responses API stream event.
 *
 * Shape-tolerant for the same reason readResponsesBody is: a reshuffled or
 * renamed event should cost a few characters, not throw in the middle of an
 * answer someone is reading. A `.delta` event carrying a string `delta` is a
 * text delta whatever it is called this month; an event whose type mentions
 * audio, reasoning or arguments is not text and is skipped.
 */
function deltaTextOf(event: Record<string, unknown>): string | null {
  const type = typeof event['type'] === 'string' ? event['type'] : ''
  if (!type.endsWith('.delta')) return null
  if (/audio|reasoning|arguments|refusal/.test(type)) return null
  return typeof event['delta'] === 'string' ? event['delta'] : null
}

/** A web search starting, or finished and saying what it looked for. */
export interface ChatSearchEvent {
  state: 'running' | 'done'
  query?: string
}

/**
 * What a hosted web search is doing, from one stream event. By shape as much
 * as by name, like the delta reader: the item type is what makes it a search.
 */
function searchEventOf(event: Record<string, unknown>): ChatSearchEvent | null {
  const type = typeof event['type'] === 'string' ? event['type'] : ''
  if (/^response\.web_search_call\.(?:in_progress|searching)$/.test(type)) return { state: 'running' }
  const item = event['item']
  if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'web_search_call') return null
  if (type === 'response.output_item.added') return { state: 'running' }
  if (type !== 'response.output_item.done') return null
  const action = (item as { action?: unknown }).action as { query?: unknown; queries?: unknown } | undefined
  const query = typeof action?.query === 'string' ? action.query
    : Array.isArray(action?.queries) && typeof action.queries[0] === 'string' ? action.queries[0]
    : undefined
  return query ? { state: 'done', query } : { state: 'done' }
}

/** A `url_citation` annotation, offsets still relative to its own content part. */
function citationOf(annotation: unknown): ChatCitation | null {
  if (!annotation || typeof annotation !== 'object') return null
  const record = annotation as Record<string, unknown>
  if (record['type'] !== 'url_citation' || typeof record['url'] !== 'string') return null
  const start = record['start_index']
  const end = record['end_index']
  return {
    url: record['url'],
    title: typeof record['title'] === 'string' ? record['title'] : '',
    start: typeof start === 'number' ? start : -1,
    end: typeof end === 'number' ? end : -1
  }
}

/**
 * The parts of a failure event that say what failed, and none of the rest. A
 * `response.failed` event carries the whole response - its instructions and
 * whatever it had written so far - and a log keeps metadata, not content.
 */
function failureFields(event: Record<string, unknown>): string {
  const response = event['response'] && typeof event['response'] === 'object' ? (event['response'] as Record<string, unknown>) : null
  const fields = {
    type: event['type'],
    error: event['error'],
    code: event['code'],
    message: event['message'],
    ...(response ? {
      response: {
        id: response['id'],
        status: response['status'],
        model: response['model'],
        error: response['error'],
        incomplete_details: response['incomplete_details']
      }
    } : {})
  }
  try {
    return JSON.stringify(fields).slice(0, MAX_LOGGED_EVENT)
  } catch {
    return '[unserializable]'
  }
}

/**
 * OpenAI reports a mid-stream failure as an event, not as an HTTP status, and
 * where it puts the reason depends on the event - core/ai-errors.ts reads them
 * all. The event's failure fields are logged as they arrived, so a shape
 * nobody has seen yet can be read on the Logs page instead of guessed at.
 */
function streamErrorOf(event: Record<string, unknown>, options: ChatStreamOptions): StreamFailure | null {
  const failure = describeStreamFailure(event, options.provider)
  if (failure) {
    const raw = failureFields(event)
    logger.error('OpenAI stopped an answer', {
      type: failure.type,
      code: failure.code ?? null,
      provider: options.provider ?? 'apiKey',
      model: options.model,
      reasoning: options.reasoning ?? null,
      message: failure.message,
      event: raw
    })
  }
  return failure
}

export interface ChatStreamOptions {
  provider?: AIProvider
  key: string
  model: string
  modelContext?: ModelContextMetadata
  input: ResponseInput[]
  /** Opt-in local function tools; ordinary lesson chat remains text-only. */
  tools?: readonly unknown[]
  toolNamespace?: { name: string; description: string }
  /**
   * Offers OpenAI's hosted web search, which the model uses or not as it sees
   * fit. Unlike `tools` it needs no loop here: the search runs on OpenAI's
   * side and the answer arrives on the same stream, with its citations.
   */
  webSearch?: boolean
  /** Told when a web search starts and when it is done. */
  onSearch?: (event: ChatSearchEvent) => void
  /** Absent: the request says nothing, and the model thinks as long as it does by default. */
  reasoning?: ReasoningEffort
  /** Called with each chunk of text as it arrives. */
  onDelta: (text: string) => void
  /** The caller's own cancel - a learner pressing Stop, or a closing window. */
  signal?: AbortSignal
}

/**
 * Streams one answer, returning everything it said.
 *
 * This runs in main because it has to: the renderer's CSP is `connect-src
 * 'self'`, so it cannot open this connection at all. Coach got away without an
 * equivalent only because WebRTC's media path is not a CSP-fetched resource; a
 * text stream is, and widening the policy to move this into the renderer would
 * hand the renderer the key along with it.
 *
 * A caller that aborts still gets what arrived: the partial answer is returned,
 * not thrown away, because a dropped connection should cost the tail of a reply
 * rather than the whole thing.
 */
export async function streamChat(options: ChatStreamOptions): Promise<{
  text: string
  aborted: boolean
  /** The pages the answer cited, with offsets into `text`. Empty unless it searched. */
  citations: ChatCitation[]
  output?: Record<string, unknown>[]
}> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()

  // The first word may be a long time coming; the cap moves by the same amount,
  // so an answer that thought for eight minutes still gets ten to be written.
  const thinking = silenceBeforeAnswerMs(options.reasoning)
  let text = ''
  const output = new Map<number, Record<string, unknown>>()
  // A citation's offsets are relative to its own content part, and `text` is
  // every part run together - so each part's starting point is remembered as
  // its first delta lands, keyed the way the events name it.
  const partStarts = new Map<string, number>()
  const partCitations = new Map<string, ChatCitation[]>()
  const partKey = (itemId: unknown, contentIndex: unknown): string => `${String(itemId)}:${String(contentIndex ?? 0)}`
  const setPart = (key: string, annotations: unknown): void => {
    if (!Array.isArray(annotations)) return
    const found = annotations.map(citationOf).filter((c): c is ChatCitation => c !== null)
    if (found.length) partCitations.set(key, found)
  }
  const citations = (): ChatCitation[] =>
    [...partCitations].flatMap(([key, list]) => {
      const offset = partStarts.get(key) ?? 0
      return list.map((c) => (c.start < 0 ? c : { ...c, start: c.start + offset, end: c.end + offset }))
    })
  let completed = false
  const started = Date.now()
  const about = { provider: options.provider ?? 'apiKey', model: options.model, reasoning: options.reasoning ?? null }
  let idle: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(abort, text ? STREAM_IDLE_MS : thinking)
  }
  const cap = setTimeout(abort, STREAM_MAX_MS + thinking - STREAM_IDLE_MS)

  try {
    touch()
    const response = await net.fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(responseRequest(options.provider ?? 'apiKey', options)),
      signal: controller.signal
    })

    if (!response.ok) {
      const body = await response.text()
      const error = options.provider === 'chatgpt' && (response.status === 401 || response.status === 403)
        ? new OpenAIError(response.status, 'ChatGPT authorization was rejected. Reconnect or choose an available model in Settings.')
        : options.provider === 'chatgpt' && response.status === 429
          ? new OpenAIError(response.status, CHATGPT_USAGE_LIMIT + resetHint(errorObjectFrom(body)))
          : new OpenAIError(response.status, messageFrom(response.status, body))
      logger.error('OpenAI refused an answer', { ...about, status: response.status, message: error.message, body: scrubSecrets(body).slice(0, MAX_LOGGED_EVENT) })
      throw error
    }
    if (!response.body) throw new OpenAIError(0, 'OpenAI returned no stream to read')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failure: StreamFailure | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      touch()
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; a frame may carry several
      // `data:` lines, and anything else in it (event:, id:, :comments) is
      // bookkeeping this does not need.
      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        separator = /\r?\n\r?\n/.exec(buffer)

        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (!payload || payload === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue // a frame we cannot read costs a few characters, never the answer
        }

        if (options.tools && event.type === 'response.output_item.done' && typeof event.output_index === 'number' && event.item && typeof event.item === 'object') {
          output.set(event.output_index, event.item as Record<string, unknown>)
        }
        if (event.type === 'response.completed') {
          completed = true
          const response = event.response as { output?: Record<string, unknown>[] } | undefined
          response?.output?.forEach((item, index) => output.set(index, item))
        }
        if (options.webSearch) {
          const search = searchEventOf(event)
          if (search) options.onSearch?.(search)
          if (event.type === 'response.output_text.annotation.added') {
            const found = citationOf(event.annotation)
            const key = partKey(event.item_id, event.content_index)
            if (found) partCitations.set(key, [...(partCitations.get(key) ?? []), found])
          }
          // The finished part, and then the finished response, carry the whole
          // list again; either replaces whatever arrived one at a time.
          if (event.type === 'response.content_part.done' && event.part && typeof event.part === 'object') {
            setPart(partKey(event.item_id, event.content_index), (event.part as { annotations?: unknown }).annotations)
          }
          if (event.type === 'response.completed') {
            const items = (event.response as { output?: unknown } | undefined)?.output
            for (const item of Array.isArray(items) ? items : []) {
              const { id, content } = (item ?? {}) as { id?: unknown; content?: unknown }
              if (!Array.isArray(content)) continue
              content.forEach((part, index) => setPart(partKey(id, index), (part as { annotations?: unknown })?.annotations))
            }
          }
        }

        const problem = streamErrorOf(event, options)
        if (problem) failure = problem
        const chunk = deltaTextOf(event)
        if (chunk) {
          const key = partKey(event.item_id, event.content_index)
          if (!partStarts.has(key)) partStarts.set(key, text.length)
          text += chunk
          options.onDelta(chunk)
        }
      }
    }

    if (failure) throw new OpenAIError(0, failure.message)
    if (!completed) {
      logger.warn('OpenAI disconnected before completing an answer', { ...about, ms: Date.now() - started, chars: text.length })
      throw new OpenAIError(0, 'OpenAI disconnected before completing the response.')
    }
    logger.debug('Answer streamed', { ...about, ms: Date.now() - started, chars: text.length, citations: partCitations.size })
    return {
      text,
      aborted: false,
      citations: citations(),
      ...(options.tools ? { output: [...output].sort(([a], [b]) => a - b).map(([, item]) => item) } : {})
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // Whose abort was it? The caller's is an outcome; ours is a timeout.
      // A stopped answer keeps the citations for the text it kept.
      if (options.signal?.aborted) return { text, aborted: true, citations: citations().filter((c) => c.end <= text.length) }
      logger.warn('OpenAI went silent and the answer was cut off', { ...about, ms: Date.now() - started, chars: text.length, beforeFirstWord: !text })
      throw new OpenAIError(0, 'OpenAI stopped answering partway through')
    }
    if (err instanceof OpenAIError) throw err
    const error = new OpenAIError(0, scrubSecrets((err as Error).message || 'could not reach OpenAI'))
    logger.error('The answer stream broke', { ...about, message: error.message, ms: Date.now() - started })
    throw error
  } finally {
    clearTimeout(idle)
    clearTimeout(cap)
    options.signal?.removeEventListener('abort', abort)
  }
}
