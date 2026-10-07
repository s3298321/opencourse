/**
 * What to tell a learner when OpenAI stops an answer partway through.
 *
 * Pure, so every shape below is a unit test rather than something read out of
 * a failed course generation. OpenAI reports a mid-stream failure as an event,
 * and puts the reason in a different place depending on which event it is:
 *
 * - `error`                → `event.error`
 * - `response.failed`      → `event.response.error`
 * - `response.incomplete`  → `event.response.incomplete_details.reason`
 *
 * The first version read only the first of those, so a ChatGPT plan running out
 * of its five-hour allowance - which arrives as `response.failed` - said
 * "OpenAI stopped the answer (response.failed)" and nothing about why. Read all
 * three, by shape, and never throw: a reshuffled event should cost a vaguer
 * sentence, not the error path itself.
 */
import type { AIProvider } from './types'

export interface StreamFailure {
  /** The sentence the learner reads. */
  message: string
  /** OpenAI's own code or reason, when it gave one - for the log, not the learner. */
  code?: string
  /** The event type that carried it. */
  type: string
}

/** Shared with the HTTP 429 branch, so a limit reads the same however it arrives. */
export const CHATGPT_USAGE_LIMIT = 'ChatGPT plan usage limit reached. Manage usage in ChatGPT Settings, or try again later.'

const USAGE_CODES = new Set(['usage_limit_reached', 'usage_not_included'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** "2 h 14 min", "6 min", "less than a minute". */
function duration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60)
  if (minutes <= 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/**
 * When a usage limit lifts, if the error says. OpenAI has used both an absolute
 * `resets_at` (unix seconds) and a relative `resets_in_seconds`.
 */
export function resetHint(error: Record<string, unknown> | null, now = Date.now()): string {
  if (!error) return ''
  const inSeconds = error['resets_in_seconds']
  const at = error['resets_at']
  const seconds = typeof inSeconds === 'number' && Number.isFinite(inSeconds)
    ? inSeconds
    : typeof at === 'number' && Number.isFinite(at) ? at - now / 1000 : NaN
  return Number.isFinite(seconds) && seconds > 0 ? ` It resets in about ${duration(seconds)}.` : ''
}

/**
 * A code OpenAI gave, as a sentence a learner can act on - or null to use
 * OpenAI's own words. A plan's usage limit is recognised by its message as well
 * as its code, because the message is the part that has stayed put.
 */
function sentenceFor(
  code: string | undefined,
  message: string | undefined,
  provider: AIProvider | undefined,
  error: Record<string, unknown> | null,
  now: number
): string | null {
  if ((code && USAGE_CODES.has(code)) || (provider === 'chatgpt' && message && /usage limit/i.test(message))) {
    return provider === 'apiKey'
      ? 'This OpenAI account has reached its usage limit. Try again later, or switch connection in Settings.' + resetHint(error, now)
      : CHATGPT_USAGE_LIMIT + resetHint(error, now)
  }
  switch (code) {
    case 'insufficient_quota':
      return 'Your OpenAI account is out of credit. Add credit in the OpenAI dashboard, or switch connection in Settings.'
    case 'rate_limit_exceeded':
      // OpenAI's own wording says how long to wait, when it has one.
      return message ? null : 'OpenAI is rate-limiting this connection. Wait a moment and try again.' + resetHint(error, now)
    case 'context_length_exceeded':
      return 'This conversation is too long for the model. Start a new chat, or pick a model with a larger context.'
    case 'max_output_tokens':
      return 'The answer reached the model\'s output limit before it finished.'
    case 'content_filter':
      return 'OpenAI\'s content filter stopped the answer.'
    case 'server_error':
      return 'OpenAI had a server error. Try again in a moment.'
    default:
      return null
  }
}

/**
 * The failure an event reports, or null when it reports none. `type` is what
 * makes it a failure; everything after that is a best effort at saying why.
 */
export function describeStreamFailure(
  event: Record<string, unknown>,
  provider?: AIProvider,
  now = Date.now()
): StreamFailure | null {
  const type = text(event['type']) ?? ''
  if (type !== 'error' && !type.endsWith('.failed') && !type.endsWith('.incomplete')) return null

  const response = record(event['response'])
  const error = record(event['error']) ?? record(response?.['error'])
  const incomplete = text(record(response?.['incomplete_details'])?.['reason'])
  // A bare `error` event has carried its fields at the top level too.
  const code = text(error?.['code']) ?? text(error?.['type']) ?? incomplete ?? (type === 'error' ? text(event['code']) : undefined)
  const message = text(error?.['message']) ?? (type === 'error' ? text(event['message']) : undefined)

  const known = sentenceFor(code, message, provider, error, now)
  if (known) return { message: known, code, type }
  if (message) return { message: code && !message.includes(code) ? `${message} (${code})` : message, ...(code ? { code } : {}), type }
  return { message: `OpenAI stopped the answer (${code ?? type})`, ...(code ? { code } : {}), type }
}
