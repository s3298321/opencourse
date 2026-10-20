import { keyring, sealKey, readAIKey, aiSettings, fittedReasoning, titleDefaults } from './credentials'
export { sealKey, readAIKey } from './credentials'
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  COURSE_TOOLS,
  DOCUMENT_TOOLS,
  READING_TOOL_INSTRUCTIONS,
  boundedResult,
  toolArguments,
  nonnegativeInteger,
  searchQuery
} from '@core/reading/tools'
import { runCourseReadingTool } from '@core/reading/course'
import type { ReadingSource, ReasoningEffort } from '@core/types'
import type {
  LearningChat,
  LearningChatView,
  LearningMessage,
  ContentRef,
  ServerAIDefaults,
  ServerAIModels
} from '@core/learning/types'
import { CHAT_MODELS, filterChatModels, isReasoningEffort, reasoningEffortsFor, webSearchFor } from '@core/sidechat/models'
import { normalizeChatTitle, TITLE_INSTRUCTIONS } from '@core/sidechat/title'
import type { Ctx } from '../context'
import { requireAccount } from '../auth/routes'
import { badRequest, conflict, notFound, tooMany, forbidden } from '../errors'
import { tx } from '../db'
import { contentRecord, readCourse } from './content'
import { change } from './sync'
import { reference } from './routes'
import { RateLimiter } from '../ratelimit'

function chatView(ctx: Ctx, account: string, id: string): LearningChatView {
  const row = ctx.db.prepare('SELECT * FROM learning_chats WHERE id=? AND account_id=?').get(id, account) as
    Record<string, unknown> | undefined
  if (!row) throw notFound()
  const chat: LearningChat = {
    id,
    kind: row.kind as LearningChat['kind'],
    contentId: String(row.content_id),
    version: String(row.version),
    title: String(row.title),
    createdAt: String(row.created_at)
  }
  const messages = (
    ctx.db.prepare('SELECT * FROM learning_messages WHERE chat_id=? ORDER BY rowid').all(id) as Record<
      string,
      unknown
    >[]
  ).map((r) => ({
    id: String(r.id),
    chatId: id,
    role: r.role as LearningMessage['role'],
    text: String(r.text),
    status: r.status as LearningMessage['status'],
    at: String(r.at),
    quote: r.quote ? String(r.quote) : undefined,
    model: r.model ? String(r.model) : undefined,
    reasoning: r.reasoning as ReasoningEffort | null,
    activity: r.activity ? JSON.parse(String(r.activity)) : null,
    citations: JSON.parse(String(r.citations))
  }))
  const firstQuestion = messages.find(m => m.role === 'user')?.text
  if (typeof row.generated_title === 'string') chat.title = row.generated_title
  else if (firstQuestion) {
    const title = firstQuestion.startsWith('About this passage:')
      ? firstQuestion.split('\n\n').at(-1)!
      : firstQuestion
    chat.title = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  } else chat.title = ''
  chat.messages = messages.length
  chat.lastMessageAt = messages.at(-1)?.at
  chat.running = messages.some(m => m.status === 'running')
  return { chat, messages }
}
interface ProviderItem {
  type: string
  encrypted_content?: string
  name?: string
  arguments?: string
  call_id?: string
  content?: { annotations?: { type: string; title: string; url: string; start_index?: number; end_index?: number }[] }[]
}
/**
 * A reasoning model is silent while it thinks, so a level that thinks longer
 * gets longer before the answer is cut off - the app's side chat allows the
 * same. The model's own default keeps the old two minutes.
 */
function answerTimeoutMs(reasoning: ReasoningEffort | null): number {
  const thinking = reasoning === 'medium' ? 2 : reasoning === 'high' ? 5 : reasoning === 'xhigh' ? 8 : 0
  return 120000 + thinking * 60000
}
/** The key's chat models. A 200 here is also the proof the key works. */
async function listModels(ctx: Ctx, key: string): Promise<ServerAIModels> {
  const response = await (ctx.aiFetch ?? fetch)('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  })
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'OpenAI rejected this server’s API key. Reconfigure it in Settings.'
        : 'OpenAI could not list models.'
    )
  const text = await response.text()
  if (text.length > 2 * 1024 ** 2) throw new Error('OpenAI could not list models.')
  const data = (JSON.parse(text) as { data?: unknown }).data
  const ids = Array.isArray(data)
    ? data
        .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(id))
    : []
  const models = filterChatModels(ids)
  return models.length ? { models, source: 'api' } : { models: [...CHAT_MODELS], source: 'fallback' }
}
export async function responseStream(
  ctx: Ctx,
  key: string,
  body: unknown,
  signal: AbortSignal,
  delta: (text: string) => void,
  activity?: (label: string, running: boolean) => void
): Promise<ProviderItem[]> {
  const response = await (ctx.aiFetch ?? fetch)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    redirect: 'error'
  })
  if (!response.ok || !response.body)
    throw new Error(
      response.status === 429
        ? 'OpenAI usage limit reached.'
        : response.status === 401 || response.status === 403
          ? 'OpenAI rejected this server’s API key. Reconfigure it in Settings.'
          : 'OpenAI could not complete this request.'
    )
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    bytes = 0,
    completed = false,
    output: ProviderItem[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8 * 1024 ** 2) throw new Error('AI response exceeded its size limit.')
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data)
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') delta(event.delta)
        if (event.type === 'response.web_search_call.in_progress' || event.type === 'response.web_search_call.searching') activity?.('Searching the web', true)
        if (event.type === 'response.web_search_call.completed') activity?.('Searched the web', false)
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') activity?.(readingActivity(event.item.name), true)
        if (event.type === 'response.completed') {
          completed = true
          output = event.response?.output ?? []
        }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type))
          throw new Error('OpenAI interrupted this answer. Try again.')
      }
    }
    if (!completed) throw new Error('The AI stream ended before completion.')
    return output
  } finally {
    await reader.cancel().catch(() => {})
  }
}
function readingActivity(name: string): string {
  const labels: Record<string, string> = {
    list_course_sections: 'Reading course outline', search_course: 'Searching the course',
    read_course_section: 'Reading course section',
    list_document_sections: 'Reading document outline', search_document: 'Searching the document',
    read_document_pages: 'Reading document pages'
  }
  return labels[name] ?? 'Reading source'
}

export function registerAIRoutes(app: FastifyInstance, ctx: Ctx): void {
  const d = ctx.db,
    active = new Map<string, { account: string; controller: AbortController; done: Promise<void> }>(),
    naming = new Map<string, { account: string; controller: AbortController; done: Promise<void> }>(),
    limits = new RateLimiter(30, 60000),
    listing = new RateLimiter(20, 60000)
  if (ctx.config.aiEncryptionKeys) keyring(ctx)
  const interrupted = d
    .prepare(
      "SELECT DISTINCT c.account_id,c.id FROM learning_messages m JOIN learning_chats c ON c.id=m.chat_id WHERE m.status='running'"
    )
    .all() as { account_id: string; id: string }[]
  d.exec("UPDATE learning_messages SET status='interrupted' WHERE status='running'")
  for (const row of interrupted) change(ctx, row.account_id, 'chat', row.id, chatView(ctx, row.account_id, row.id))
  app.addHook('onClose', async () => {
    const all = [...active.values(), ...naming.values()]
    for (const a of all) a.controller.abort()
    await Promise.all(all.map((a) => a.done))
  })
  const stopAccount = (account: string) => {
    for (const a of [...active.values(), ...naming.values()]) if (a.account === account) a.controller.abort()
  }
  /**
   * Names a conversation after its first answer: a separate, best-effort
   * request that never holds up the answer or writes into its transcript. A
   * failure leaves the first question as the title, as before.
   */
  function nameChat(account: string, chatId: string, key: string, defaults: ServerAIDefaults): void {
    if (naming.has(chatId)) return
    const row = d
      .prepare('SELECT generated_title FROM learning_chats WHERE id=? AND account_id=?')
      .get(chatId, account) as { generated_title: string | null } | undefined
    const prompt = d
      .prepare("SELECT text FROM learning_messages WHERE chat_id=? AND role='user' ORDER BY rowid LIMIT 1")
      .get(chatId) as { text: string } | undefined
    if (!row || row.generated_title !== null || !prompt) return
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)])
    const done = (async () => {
      try {
        let text = ''
        await responseStream(
          ctx,
          key,
          {
            model: defaults.model,
            store: false,
            stream: true,
            max_output_tokens: 2048,
            ...(defaults.reasoning ? { reasoning: { effort: defaults.reasoning } } : {}),
            instructions: TITLE_INSTRUCTIONS,
            input: [{ role: 'user', content: JSON.stringify({ prompt: prompt.text.slice(0, 4000) }) }]
          },
          signal,
          (delta) => {
            text += delta
            if (text.length > 2000) throw new Error('AI response exceeded its size limit.')
          }
        )
        const title = normalizeChatTitle(text)
        if (!title || signal.aborted) return
        const saved = d
          .prepare('UPDATE learning_chats SET generated_title=? WHERE id=? AND account_id=? AND generated_title IS NULL')
          .run(title, chatId, account)
        if (Number(saved.changes)) change(ctx, account, 'chat', chatId, chatView(ctx, account, chatId))
      } catch {
        // Metadata only: the reply is derived from the conversation.
        if (!controller.signal.aborted)
          app.log.info({ accountId: account, chatId, model: defaults.model }, 'learning.ai.title_failed')
      } finally {
        naming.delete(chatId)
      }
    })()
    naming.set(chatId, { account, controller, done })
  }
  app.get('/api/v1/me/ai', async (req) => aiSettings(ctx, requireAccount(req).id))
  app.get('/api/v1/me/ai/models', async (req): Promise<ServerAIModels> => {
    const account = requireAccount(req).id,
      settings = aiSettings(ctx, account)
    if (!settings.enabled || !settings.configured) return { models: [], source: 'fallback' }
    if (!listing.hit(account)) throw tooMany('Please wait before refreshing models again.')
    try {
      return await listModels(ctx, readAIKey(ctx, account))
    } catch (error) {
      const message =
        error instanceof Error && /^OpenAI/.test(error.message) ? error.message : 'OpenAI could not list models.'
      return { models: [...CHAT_MODELS], source: 'fallback', error: message }
    }
  })
  app.put('/api/v1/me/ai', async (req) => {
    const account = requireAccount(req).id,
      body = req.body as {
        key?: string
        enabledModels?: string[] | null
        model?: string
        reasoning?: unknown
        webSearch?: boolean
        title?: { model?: unknown; reasoning?: unknown } | null
      }
    const model = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value),
      level = (value: unknown) => value === null || isReasoningEffort(value)
    if (
      !body ||
      (body.enabledModels !== undefined && body.enabledModels !== null && (!Array.isArray(body.enabledModels) || body.enabledModels.length > 500 || body.enabledModels.some(id => !model(id)))) ||
      (body.model !== undefined && !model(body.model)) ||
      (body.reasoning !== undefined && !level(body.reasoning)) ||
      (body.title !== undefined &&
        body.title !== null &&
        (typeof body.title !== 'object' || !model(body.title.model) || !level(body.title.reasoning ?? null))) ||
      (body.key !== undefined &&
        (typeof body.key !== 'string' || body.key.length > 1024 || !body.key.startsWith('sk-'))) ||
      (body.webSearch !== undefined && typeof body.webSearch !== 'boolean')
    )
      throw badRequest('invalid_ai_settings', 'Choose valid AI settings and an OpenAI API key.')
    const old = aiSettings(ctx, account),
      chatModel = body.model ?? old.model,
      title =
        body.title === undefined
          ? old.title
          : body.title === null
            ? null
            : { model: String(body.title.model), reasoning: body.title.reasoning }
    const enabledModels = body.enabledModels === undefined ? old.enabledModels ?? null : body.enabledModels
    if (enabledModels?.length && !enabledModels.includes(chatModel))
      throw badRequest('invalid_ai_settings', 'The default model must be enabled.')
    const encrypted = body.key ? sealKey(ctx, account, body.key) : null
    d.prepare(
      `INSERT INTO learning_ai(account_id,model,reasoning,web_search,title_model,title_reasoning) VALUES(?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET model=excluded.model,reasoning=excluded.reasoning,
       web_search=excluded.web_search,title_model=excluded.title_model,title_reasoning=excluded.title_reasoning`
    ).run(
      account,
      chatModel,
      fittedReasoning(chatModel, body.reasoning === undefined ? old.reasoning : body.reasoning),
      Number(body.webSearch ?? old.webSearch),
      title?.model ?? null,
      title ? fittedReasoning(title.model, title.reasoning) : null
    )
    d.prepare('UPDATE learning_ai SET enabled_models=? WHERE account_id=?').run(enabledModels === null ? null : JSON.stringify([...new Set(enabledModels)]), account)
    if (body.key) {
      d.prepare('UPDATE learning_ai SET secret=?,hint=? WHERE account_id=?').run(encrypted, body.key.slice(-4), account)
      stopAccount(account)
    }
    return aiSettings(ctx, account)
  })
  app.delete('/api/v1/me/ai', async (req) => {
    const account = requireAccount(req).id
    d.prepare('UPDATE learning_ai SET secret=NULL,hint=NULL WHERE account_id=?').run(account)
    stopAccount(account)
    return aiSettings(ctx, account)
  })
  app.get('/api/v1/learning/chats', async (req) => {
    const account = requireAccount(req).id,
      q = req.query as { kind: string; id: string }
    return {
      chats: (
        d
          .prepare(
            'SELECT id FROM learning_chats WHERE account_id=? AND kind=? AND content_id=? ORDER BY created_at DESC'
          )
          .all(account, q.kind ?? '', q.id ?? '') as { id: string }[]
      ).map((r) => chatView(ctx, account, r.id).chat)
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
    }
  })
  app.post('/api/v1/learning/chats', async (req) => {
    const account = requireAccount(req).id,
      ref = reference(req.body)
    const content = contentRecord(ctx, account, ref),
      id = randomUUID()
    d.prepare('INSERT INTO learning_chats(id,account_id,kind,content_id,version,title,created_at) VALUES(?,?,?,?,?,?,?)').run(
      id,
      account,
      ref.kind,
      ref.id,
      ref.version,
      content.title,
      new Date().toISOString()
    )
    const view = chatView(ctx, account, id)
    change(ctx, account, 'chat', id, view)
    return view
  })
  app.post('/api/v1/learning/chats/import', { bodyLimit: 2 * 1024 ** 2 }, async (req) => {
    if (req.via === 'web') throw forbidden('desktop_only', 'Legacy chat import is available in the desktop app.')
    const account = requireAccount(req).id,
      body = req.body as { importId: string; title: string; messages: { role: string; text: string; at: string }[] },
      ref = reference(req.body)
    contentRecord(ctx, account, ref)
    if (
      typeof body.importId !== 'string' ||
      body.importId.length > 160 ||
      typeof body.title !== 'string' ||
      body.title.length > 300 ||
      !Array.isArray(body.messages) ||
      body.messages.length > 1000 ||
      body.messages.some(
        (m) =>
          !['user', 'assistant'].includes(m.role) ||
          typeof m.text !== 'string' ||
          m.text.length > 100000 ||
          !Number.isFinite(Date.parse(m.at))
      )
    )
      throw badRequest('invalid_import', 'Invalid reading history.')
    const id = createHash('sha256').update(`${account}:${ref.kind}:${ref.id}:${body.importId}`).digest('hex')
    tx(d, () => {
      if (d.prepare('SELECT 1 FROM learning_chats WHERE id=?').get(id)) return
      d.prepare('INSERT INTO learning_chats(id,account_id,kind,content_id,version,title,created_at) VALUES(?,?,?,?,?,?,?)').run(
        id,
        account,
        ref.kind,
        ref.id,
        ref.version,
        body.title,
        body.messages[0]?.at ?? new Date().toISOString()
      )
      for (const [i, m] of body.messages.entries())
        d.prepare(
          "INSERT INTO learning_messages(id,chat_id,role,text,status,at,request_id) VALUES(?,?,?,?,'complete',?,?)"
        ).run(`${id}:${i}`, id, m.role, m.text, m.at, `${body.importId}:${i}`)
      change(ctx, account, 'chat', id, chatView(ctx, account, id))
    })
    return chatView(ctx, account, id)
  })
  app.get('/api/v1/learning/chats/:id', async (req) =>
    chatView(ctx, requireAccount(req).id, (req.params as { id: string }).id)
  )
  app.delete('/api/v1/learning/chats/:id', async (req) => {
    const account = requireAccount(req).id,
      { id } = req.params as { id: string }
    chatView(ctx, account, id)
    const generation = active.get(id),
      title = naming.get(id)
    generation?.controller.abort()
    title?.controller.abort()
    await Promise.all([generation?.done, title?.done])
    tx(d, () => {
      d.prepare('DELETE FROM learning_chats WHERE id=? AND account_id=?').run(id, account)
      // Old change-feed snapshots must not retain a deleted private transcript.
      d.prepare("DELETE FROM learning_changes WHERE account_id=? AND type='chat' AND key=?").run(account, id)
      change(ctx, account, 'chat', id, { deleted: true })
    })
    return { ok: true }
  })
  app.post('/api/v1/learning/chats/:id/cancel', async (req) => {
    const account = requireAccount(req).id,
      { id } = req.params as { id: string }
    chatView(ctx, account, id)
    active.get(id)?.controller.abort()
    return { ok: true }
  })
  app.post('/api/v1/learning/chats/:id/messages', async (req) => {
    const account = requireAccount(req).id,
      { id } = req.params as { id: string },
      view = chatView(ctx, account, id),
      body = req.body as { text: string; requestId: string; quote?: string; model?: string; reasoning?: unknown }
    if (
      typeof body?.text !== 'string' ||
      !body.text.trim() ||
      (body.quote !== undefined && (typeof body.quote !== 'string' || body.quote.length > 8000)) ||
      (body.model !== undefined && (typeof body.model !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(body.model))) ||
      (body.reasoning !== undefined && body.reasoning !== null && !isReasoningEffort(body.reasoning)) ||
      body.text.length > 16000 ||
      typeof body.requestId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(body.requestId)
    )
      throw badRequest('invalid_message', 'Enter a message of at most 16,000 characters.')
    const previous = d
      .prepare("SELECT id FROM learning_messages WHERE chat_id=? AND request_id=? AND role='assistant'")
      .get(id, body.requestId) as { id: string } | undefined
    if (previous) return { messageId: previous.id }
    if (view.messages.reduce((sum, m) => sum + m.text.length + (m.quote?.length ?? 0), 0) > 1024 ** 2)
      throw conflict(
        'conversation_full',
        'Start a new conversation to continue. This conversation’s history is retained.'
      )
    if (active.has(id)) throw conflict('answering', 'This conversation is already answering.')
    if ([...active.values()].filter((a) => a.account === account).length >= 2 || !limits.hit(account))
      throw tooMany('Please wait before asking another question.')
    const ref: ContentRef = { kind: view.chat.kind, id: view.chat.contentId, version: view.chat.version }
    contentRecord(ctx, account, ref)
    const key = readAIKey(ctx, account),
      settings = aiSettings(ctx, account),
      messageId = randomUUID(),
      controller = new AbortController()
    settings.model = body.model ?? settings.model
    settings.reasoning = fittedReasoning(settings.model, body.reasoning === undefined ? settings.reasoning : body.reasoning)
    if (settings.enabledModels && !settings.enabledModels.includes(settings.model))
      throw badRequest('model_disabled', 'Enable this model in Settings or choose an enabled model.')
    const at = new Date().toISOString()
    tx(d, () => {
      d.prepare(
        "INSERT INTO learning_messages(id,chat_id,role,text,status,at,request_id,quote) VALUES(?,?,'user',?,'complete',?,?,?)"
      ).run(randomUUID(), id, body.text, at, body.requestId, body.quote ?? null)
      d.prepare(
        "INSERT INTO learning_messages(id,chat_id,role,text,status,at,request_id,model,reasoning) VALUES(?,?,'assistant','','running',?,?,?,?)"
      ).run(messageId, id, at, body.requestId, settings.model, settings.reasoning)
    })
    const activity = (label: string, running: boolean) => {
      d.prepare('UPDATE learning_messages SET activity=? WHERE id=?').run(JSON.stringify({ label, running }), messageId)
      d.prepare('INSERT INTO learning_stream(message_id,event) VALUES(?,?)').run(messageId, JSON.stringify({ type: 'activity', messageId }))
    }
    const startedAt = Date.now()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(answerTimeoutMs(settings.reasoning))])
    // A reasoning model's items go back in the next round; with `store: false`
    // they only can as encrypted content.
    const thinks = reasoningEffortsFor(settings.model).length > 0
    const done = (async () => {
      const citations: LearningMessage['citations'] = [],
        sources: ReadingSource[] = [],
        budget = { chars: 0, signal }
      let status: LearningMessage['status'] = 'complete',
        answerChars = 0
      try {
        const course = ref.kind === 'course' ? await readCourse(ctx, account, ref) : null
        const history = chatView(ctx, account, id)
          .messages.filter((m) => m.id !== messageId && m.text)
          .slice(-40)
        let chars = 0
        const input: unknown[] = history
          .reverse()
          .filter((m) => {
            chars += m.text.length + (m.quote?.length ?? 0)
            return chars <= 100000
          })
          .reverse()
          .map((m) => ({ role: m.role, content: m.quote ? `About this passage:\n${m.quote}\n\n${m.text}` : m.text }))
        let calls = 0
        for (let round = 0; round < 6; round++) {
          signal.throwIfAborted()
          contentRecord(ctx, account, ref)
          const roundStart = answerChars
          const output = await responseStream(
            ctx,
            key,
            {
              model: settings.model,
              store: false,
              stream: true,
              max_output_tokens: thinks ? 16384 : 8192,
              ...(thinks ? { include: ['reasoning.encrypted_content'] } : {}),
              ...(settings.reasoning ? { reasoning: { effort: settings.reasoning } } : {}),
              instructions: `You are a helpful learning tutor. ${READING_TOOL_INSTRUCTIONS}`,
              input,
              tools: [
                ...(ref.kind === 'course' ? COURSE_TOOLS : DOCUMENT_TOOLS),
                ...(settings.webSearch && webSearchFor(settings.model, settings.reasoning)
                  ? [{ type: 'web_search' }]
                  : [])
              ]
            },
            signal,
            (text) => {
              signal.throwIfAborted()
              contentRecord(ctx, account, ref)
              if (!d.prepare('SELECT 1 FROM sessions WHERE id=?').get(req.sessionId ?? ''))
                throw new Error('Session ended.')
              answerChars += text.length
              if (answerChars > 64000) throw new Error('AI response exceeded its size limit.')
              d.prepare("UPDATE learning_messages SET activity=json_set(activity,'$.running',json('false')) WHERE id=? AND activity IS NOT NULL").run(messageId)
              d.prepare('UPDATE learning_messages SET text=text||? WHERE id=?').run(text, messageId)
              d.prepare('INSERT INTO learning_stream(message_id,event) VALUES(?,?)').run(
                messageId,
                JSON.stringify({ type: 'delta', messageId, text })
              )
            },
            activity
          )
          input.push(...output.filter((item) => item.type !== 'reasoning' || item.encrypted_content))
          for (const item of output)
            for (const part of item.content ?? [])
              for (const a of part.annotations ?? [])
                if (a.type === 'url_citation' && /^https?:\/\//.test(a.url))
                  citations.push({ title: a.title, url: a.url, start: a.start_index === undefined ? -1 : roundStart + a.start_index, end: a.end_index === undefined ? -1 : roundStart + a.end_index })
          const functions = output.filter((item) => item.type === 'function_call')
          if (!functions.length) break
          for (const item of functions) {
            if (++calls > 12) throw new Error('Retrieval limit reached. Ask a more focused question.')
            contentRecord(ctx, account, ref)
            activity(readingActivity(item.name!), true)
            const args = toolArguments(JSON.parse(item.arguments ?? '{}'))
            let result: string
            if (course) result = runCourseReadingTool(course, item.name!, args, budget, sources)
            else {
              const cursor = () => nonnegativeInteger(args.cursor)
              let value: unknown
              if (item.name === 'list_document_sections') {
                const row = d
                  .prepare('SELECT sections FROM document_versions WHERE document_id=? AND version=?')
                  .get(ref.id, ref.version) as { sections: string }
                const all = JSON.parse(row.sections)
                value = {
                  sections: all.slice(cursor(), cursor() + 30),
                  nextCursor: cursor() + 30 < all.length ? cursor() + 30 : null
                }
              } else if (item.name === 'search_document') {
                const query = searchQuery(args.query)
                value = {
                  status: (
                    d
                      .prepare('SELECT status FROM document_versions WHERE document_id=? AND version=?')
                      .get(ref.id, ref.version) as { status: string }
                  ).status,
                  nextCursor: cursor() + 8,
                  hits: (
                    d
                      .prepare(
                        'SELECT page,text FROM document_text WHERE document_id=? AND version=? AND instr(lower(text),lower(?))>0 LIMIT 8 OFFSET ?'
                      )
                      .all(ref.id, ref.version, query, cursor()) as { page: number; text: string }[]
                  ).map((r) => ({
                    page: r.page,
                    excerpt: r.text.slice(
                      Math.max(0, r.text.toLowerCase().indexOf(query.toLowerCase()) - 100),
                      r.text.toLowerCase().indexOf(query.toLowerCase()) + 500
                    )
                  }))
                }
              } else if (item.name === 'read_document_pages') {
                const start = nonnegativeInteger(args.start_page),
                  count = Math.min(3, nonnegativeInteger(args.count)),
                  offset = nonnegativeInteger(args.offset)
                const pages = d
                  .prepare(
                    'SELECT page,text FROM document_text WHERE document_id=? AND version=? AND page>=? AND page<? ORDER BY page'
                  )
                  .all(ref.id, ref.version, start, start + count) as { page: number; text: string }[]
                value = {
                  pages: pages.map((r) => ({
                    page: r.page,
                    text: r.text.slice(offset, offset + 2000),
                    nextOffset: offset + 2000 < r.text.length ? offset + 2000 : null
                  }))
                }
                pages.forEach((p) => citations.push({ title: `Page ${p.page}`, page: p.page }))
              } else throw new Error('Unknown reading tool.')
              result = boundedResult(value, budget)
            }
            activity(readingActivity(item.name!), false)
            input.push({ type: 'function_call_output', call_id: item.call_id, output: result })
          }
          if (round === 5) throw new Error('Retrieval limit reached. Ask a more focused question.')
        }
        for (const source of sources)
          if (source.kind === 'course')
            citations.push({ title: source.title, moduleId: source.moduleId, lessonId: source.lessonId })
      } catch (error) {
        status = controller.signal.aborted ? 'cancelled' : 'error'
        const message =
          status === 'cancelled'
            ? 'Answer cancelled.'
            : signal.aborted
              ? 'The answer timed out.'
              : error instanceof Error && /^(OpenAI|The AI|Retrieval|AI response)/.test(error.message)
                ? error.message
                : 'The answer could not be completed.'
        d.prepare('UPDATE learning_messages SET text=text||? WHERE id=?').run(`\n\n${message}`, messageId)
      } finally {
        try {
          if (!d.prepare('SELECT 1 FROM learning_chats WHERE id=?').get(id)) return
          d.prepare("UPDATE learning_messages SET activity=json_set(activity,'$.running',json('false')) WHERE id=? AND activity IS NOT NULL").run(messageId)
          d.prepare('UPDATE learning_messages SET status=?,citations=? WHERE id=?').run(
            status,
            JSON.stringify(citations.slice(0, 200)),
            messageId
          )
          d.prepare('INSERT INTO learning_stream(message_id,event) VALUES(?,?)').run(
            messageId,
            JSON.stringify({ type: 'done', messageId, status })
          )
          change(ctx, account, 'chat', id, chatView(ctx, account, id))
          if (status === 'complete') nameChat(account, id, key, titleDefaults(settings))
        } finally {
          active.delete(id)
          app.log.info(
            { accountId: account, chatId: id, status, durationMs: Date.now() - startedAt },
            'learning.ai.finished'
          )
        }
      }
    })()
    active.set(id, { account, controller, done })
    return { messageId }
  })
  app.get('/api/v1/learning/chats/:id/events', async (req, reply) => {
    const account = requireAccount(req).id,
      { id } = req.params as { id: string }
    chatView(ctx, account, id)
    let cursor = Number((req.query as { after?: string }).after ?? req.headers['last-event-id'] ?? 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw badRequest('invalid_cursor', 'Invalid stream cursor.')
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    })
    const pump = () => {
      try {
        if (
          !d
            .prepare(
              'SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND a.disabled_at IS NULL AND s.expires_at>?'
            )
            .get(req.sessionId ?? '', new Date().toISOString())
        ) {
          clearInterval(timer)
          reply.raw.end()
          return
        }
        const rows = d
          .prepare(
            'SELECT s.id,s.event FROM learning_stream s JOIN learning_messages m ON m.id=s.message_id WHERE m.chat_id=? AND s.id>? ORDER BY s.id LIMIT 100'
          )
          .all(id, cursor) as { id: number; event: string }[]
        for (const row of rows) {
          cursor = row.id
          reply.raw.write(`id: ${row.id}\ndata: ${row.event}\n\n`)
        }
        if (!active.has(id) && rows.length < 100) {
          clearInterval(timer)
          reply.raw.end()
        }
      } catch {
        clearInterval(timer)
        reply.raw.end()
      }
    }
    const timer = setInterval(pump, 200)
    reply.raw.on('close', () => clearInterval(timer))
    pump()
  })
}
