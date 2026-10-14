import { createHash, randomUUID } from 'node:crypto'
import { runTextAgent, type ProjectAgentOptions, type ResponseInput, type ResponseUsage } from '../core/text-chat/agent'
import type { AIProvider } from '../core/types'
import { db } from './db'
import { currentUserId, requireUser } from './users'
import { subscriptionIdentity } from './subscription'
import { requestDiagnostics } from './ai-diagnostics'
import { log } from './log'

export interface TextSession {
  mode: 'chat' | 'document' | 'project' | 'authoring'
  chatId: string
  turnSeq: number
  model: string
  provider: AIProvider
  key: string
  tools: readonly unknown[]
  webSearch?: boolean
  context: ResponseInput[]
  valid: () => boolean
  sources?: unknown[]
  volatileTools?: boolean
  sourceVersion?: string | number
}
const tables = { chat: 'chats', document: 'document_chats', project: 'course_project_chats', authoring: 'authoring_chats' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Reject malformed checkpoints before they can become protocol input. */
export function validContinuation(value: unknown): value is ResponseInput[] {
  if (!Array.isArray(value)) return false
  const calls = new Set<string>(), results = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') return false
    if (!('type' in item) && 'role' in item) { if (typeof item.role !== 'string' || typeof item.content !== 'string') return false; continue }
    if (typeof item.type !== 'string') return false
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string' || calls.has(item.call_id)) return false
      calls.add(item.call_id)
    }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || results.has(item.call_id) || typeof item.output !== 'string') return false
      results.add(item.call_id)
    }
  }
  return [...calls].every(id => results.has(id))
}

/** One shared run boundary; mode handlers retain ownership of their UI and source invariants. */
export async function runChatAgent(options: ProjectAgentOptions & { session: TextSession }): Promise<{ stopped: boolean }> {
  const session = options.session, owner = requireUser(), database = db(), runId = randomUUID()
  const logger = log.child('ai.run', { userId: owner, data: { runId, mode: session.mode, chatId: session.chatId, turnSeq: session.turnSeq } })
  const instructions = options.input.filter(i => 'role' in i && (i.role === 'system' || i.role === 'developer'))
  const contract = hash({ version: 1, owner, provider: session.provider, model: session.model,
    connection: session.provider === 'apiKey' ? hash(session.key) : subscriptionIdentity()?.id ?? hash(session.key),
    instructions, sourceVersion: session.sourceVersion, tools: session.tools, webSearch: session.webSearch ?? false })
  const contextKey = hash(session.context)
  const valid = () => { try { return currentUserId() === owner && session.valid() && !!database.prepare(`SELECT id FROM ${tables[session.mode]} WHERE id=?`).get(session.chatId) } catch { return false } }
  const remove = () => database.prepare('DELETE FROM text_chat_state WHERE mode=? AND chat_id=?').run(session.mode, session.chatId)
  const removeCurrent = () => database.prepare('DELETE FROM text_chat_state WHERE mode=? AND chat_id=? AND turn_seq=?').run(session.mode, session.chatId, session.turnSeq)
  let input = options.input, restored = false
  try {
    const saved = database.prepare('SELECT * FROM text_chat_state WHERE mode=? AND chat_id=?').get(session.mode, session.chatId) as { contract: string; context_key: string; status: string; turn_seq: number; payload: string; sources: string } | undefined
    if (saved?.contract === contract && saved.status === 'complete' && saved.turn_seq < session.turnSeq) {
      const state = JSON.parse(saved.payload) as { items?: unknown; context?: ResponseInput[] }
      const sources: unknown = JSON.parse(saved.sources)
      const items = state.items
      if (validContinuation(items) && validContinuation(state.context) && Array.isArray(sources)) {
        const latest = options.input.at(-1)
        if (latest && 'role' in latest && latest.role === 'user') {
          const changed = saved.context_key !== contextKey
          const oldContexts = new Set(state.context.map(i => JSON.stringify(i)))
          const history = items.map(item => {
            if (changed && oldContexts.has(JSON.stringify(item))) return { role: 'user', content: `[Earlier lesson / document / editor context. Retrieve current source content with tools.]` }
            if (session.volatileTools && 'type' in item && item.type === 'function_call_output') return { ...item, output: JSON.stringify({ note: 'Historical project evidence omitted because files can change. Retrieve current requirements and files before reviewing.' }) }
            return item
          })
          input = [...history, ...(changed || session.volatileTools ? session.context : []), latest]
          restored = true
          if (session.sources && Array.isArray(sources)) for (const source of sources) {
            if (!session.sources.some(existing => JSON.stringify(existing) === JSON.stringify(source))) session.sources.push(source)
          }
        }
      }
    }
    remove()
  } catch { logger.warn('Continuation unavailable; rebuilding from transcript') }
  if (!restored) logger.info('Conversation context rebuilt', { inputChars: JSON.stringify(input).length })
  let requests = 0, toolCalls = 0, compactions = 0, knownUsage = 0
  const total: ResponseUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }
  const started = Date.now()
  let status = 'failed'
  let storageFailed = false
  const checkpoint = (items: ResponseInput[]) => {
    if (!valid() || options.signal.aborted || !validContinuation(items)) return
    const payload = JSON.stringify({ items, context: session.context })
    // Never partially save opaque data. Oversized state falls back to the transcript.
    if (payload.length > 8 * 1024 * 1024) { removeCurrent(); logger.warn('Continuation exceeded local storage budget'); return }
    try { database.prepare(`INSERT INTO text_chat_state(mode,chat_id,contract,context_key,turn_seq,status,payload,sources)
      VALUES(?,?,?,?,?,'running',?,?) ON CONFLICT(mode,chat_id) DO UPDATE SET contract=excluded.contract,
      context_key=excluded.context_key,turn_seq=excluded.turn_seq,status=excluded.status,payload=excluded.payload,sources=excluded.sources
      WHERE text_chat_state.turn_seq <= excluded.turn_seq`)
      .run(session.mode, session.chatId, contract, contextKey, session.turnSeq, payload, JSON.stringify(session.sources ?? []))
    } catch { storageFailed = true; logger.warn('Continuation could not be saved; next turn will rebuild from transcript') }
    options.checkpoint?.(items)
  }
  try {
    const result = await runTextAgent({ ...options, input, checkpoint,
      stream: async items => {
        if (!valid()) throw new Error('The conversation or source changed.')
        const result = await requestDiagnostics.run({ mode: session.mode, chatId: session.chatId, turnSeq: session.turnSeq, request: ++requests, kind: 'answer' }, () => options.stream(items))
        compactions += result.output?.filter(item => item.type === 'compaction').length ?? 0
        if (result.usage) {
          knownUsage++
          total.input += result.usage.input; total.output += result.usage.output; total.total += result.usage.total
          total.cachedInput = total.cachedInput === null || result.usage.cachedInput === null ? null : total.cachedInput + result.usage.cachedInput
          total.reasoning = total.reasoning === null || result.usage.reasoning === null ? null : total.reasoning + result.usage.reasoning
        }
        return result
      },
      tool: async (name, args, callId) => {
        if (!valid() || options.signal.aborted) throw new Error('The conversation or source changed.')
        toolCalls++
        return options.tool(name, args, callId)
      }
    })
    status = result.stopped ? 'stopped' : 'complete'
    if (!result.stopped && valid() && !storageFailed) {
      try { database.prepare("UPDATE text_chat_state SET status='complete' WHERE mode=? AND chat_id=? AND turn_seq=?").run(session.mode, session.chatId, session.turnSeq) }
      catch { logger.warn('Continuation could not be completed; next turn will rebuild from transcript') }
    }
    return result
  } finally {
    if (status !== 'complete' || storageFailed) { try { removeCurrent() } catch { /* user deletion or closed database */ } }
    logger.info('AI turn usage', { model: session.model, provider: session.provider, status, restored, requests, toolCalls, compactions,
      ms: Date.now() - started, knownUsageRequests: knownUsage, usageComplete: knownUsage === requests,
      usage: knownUsage ? total : null })
  }
}
