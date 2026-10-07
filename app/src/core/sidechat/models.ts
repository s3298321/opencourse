/**
 * Which models a side chat can use.
 *
 * Same arrangement as core/coach/models.ts, and for the same reason: OpenAI's
 * /v1/models lists everything a key can reach with no capability filter, so the
 * real list is whatever that returns, filtered by id. This file holds the
 * filter and a curated fallback, so a first run with no network still offers a
 * working choice rather than an empty dropdown.
 */
import type { ChatModel, ReasoningEffort } from '../types'

export const DEFAULT_CHAT_MODEL = 'gpt-5.6-terra'

/** Known good as of the last time this was checked; the API is the source of truth. */
export const CHAT_MODELS: readonly ChatModel[] = [
  { id: DEFAULT_CHAT_MODEL, label: DEFAULT_CHAT_MODEL },
  { id: 'gpt-5.1', label: 'gpt-5.1' },
  { id: 'gpt-5-mini', label: 'gpt-5-mini' }
] as const

/**
 * A key reaches embeddings, transcription, speech and image models too, and
 * every one of them would 400 the moment someone picked it. Exclusion by
 * substring is coarse but it fails the safe way: a model wrongly left out can
 * still be reached by a newer curated list, whereas one wrongly left in breaks
 * a conversation with an error the learner cannot act on.
 */
const NOT_CHAT = [
  'realtime',
  'transcribe',
  'embedding',
  'whisper',
  'moderation',
  'tts',
  'audio',
  'dall-e',
  'image',
  'search',
  'codex'
]

export function isChatModelId(id: string): boolean {
  if (!id.startsWith('gpt-') && !id.startsWith('o')) return false
  return !NOT_CHAT.some((bad) => id.includes(bad))
}

/**
 * Newest-looking first, so the default sits at the top. Ids are otherwise
 * sorted lexically, which keeps the list stable between launches.
 */
export function filterChatModels(ids: readonly string[]): ChatModel[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !isChatModelId(id) || seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  kept.sort((a, b) => {
    if (a === DEFAULT_CHAT_MODEL) return -1
    if (b === DEFAULT_CHAT_MODEL) return 1
    // A plain id sorts above its own dated snapshots: gpt-5.1 before
    // gpt-5.1-2026-01-01.
    const dated = (s: string): number => (/\d{4}-\d{2}-\d{2}$/.test(s) ? 1 : 0)
    return dated(a) - dated(b) || a.localeCompare(b)
  })
  return kept.map((id) => ({ id, label: id }))
}

/* --- which models the picker offers ---------------------------------------- */

/**
 * The picker's list: the models the learner enabled in Settings, in the order
 * the key's list gives them. An enabled id the key no longer reaches drops out,
 * because offering it would only produce an error - and if that leaves nothing,
 * the whole list comes back, because an empty dropdown is a dead end.
 */
export function offeredModels(available: readonly ChatModel[], enabled: readonly string[] | null): ChatModel[] {
  if (!enabled) return [...available]
  const on = new Set(enabled)
  const kept = available.filter((model) => on.has(model.id))
  return kept.length ? kept : [...available]
}

/** What a new chat starts on: the default, unless the learner turned it off. */
export function defaultChatModel(enabled: readonly string[] | null, preferred?: string): string {
  if (preferred && (!enabled || enabled.includes(preferred))) return preferred
  if (!enabled || !enabled.length || enabled.includes(DEFAULT_CHAT_MODEL)) return DEFAULT_CHAT_MODEL
  return enabled[0]!
}

/* --- reasoning --------------------------------------------------------------- */

/** Every level, least thought first - the order the picker lists them in. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Which levels a model accepts, judged from its id.
 *
 * /v1/models says nothing about capabilities, so this is the same kind of
 * guess `isChatModelId` is, and it is built to fail the same safe way. A model
 * it does not recognise gets no levels at all: the picker hides itself and the
 * request carries no `reasoning`, which every model accepts. A level OpenAI
 * refuses is a 400 whose message names the levels it would take - readable,
 * and fixed from the same picker - whereas a level sent to a model with no
 * reasoning at all breaks every question in the chat.
 *
 * The sets moved between generations: gpt-5 added `minimal`, 5.1 replaced it
 * with `none`, 5.2 added `xhigh`. Later 5.x and anything after are assumed to
 * keep 5.2's set. The chat-tuned and pro variants pin their own effort.
 */
export function reasoningEffortsFor(model: string): readonly ReasoningEffort[] {
  const id = model.toLowerCase()
  if (/-chat(?:-|$)|-pro(?:-|$)/.test(id)) return []
  if (/^o\d/.test(id)) return id.startsWith('o1-mini') ? [] : ['low', 'medium', 'high']
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id)
  if (!gpt) return []
  const major = Number(gpt[1])
  const minor = Number(gpt[2] ?? 0)
  if (major < 5) return []
  if (major === 5 && minor === 0) return ['minimal', 'low', 'medium', 'high']
  if (major === 5 && minor === 1) return ['none', 'low', 'medium', 'high']
  return ['none', 'low', 'medium', 'high', 'xhigh']
}

/* --- web search -------------------------------------------------------------- */

/**
 * Whether a model can take OpenAI's hosted `web_search` tool at this reasoning
 * level, judged from its id.
 *
 * The same kind of guess as `reasoningEffortsFor`, and built to fail the same
 * safe way: an id it does not recognise gets no search, and the question goes
 * out as it always did. The other direction is covered in chat.ts - a 400 that
 * names the tool is retried once without it - so a wrong yes costs one
 * unbilled round trip rather than a chat that cannot answer.
 *
 * As documented when this was written: the gpt-5 family and later take it,
 * except gpt-5 itself at `minimal`; gpt-4o and gpt-4.1 do, their nano sizes do
 * not; o3 and o4-mini do, the o1 line and o3-mini do not. Chat-tuned variants
 * are left out because they pin their own behaviour, as they do for reasoning.
 */
export function webSearchFor(model: string, reasoning: ReasoningEffort | null): boolean {
  const id = model.toLowerCase()
  if (/-chat(?:-|$)|-nano(?:-|$)/.test(id)) return false
  if (/^o\d/.test(id)) return /^(?:o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
  if (/^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return true
  if (/^gpt-4\.1(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return true
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id)
  if (!gpt) return false
  const major = Number(gpt[1])
  const minor = Number(gpt[2] ?? 0)
  if (major < 5) return false
  if (major === 5 && minor === 0 && reasoning === 'minimal') return false
  return true
}
