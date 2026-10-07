/**
 * Realtime API events, built by hand.
 *
 * The same idea as helpers/zip.ts: the interesting cases cannot be produced by
 * the real thing on demand. A truncated tool call, a repeated `.done`, an event
 * type nobody has seen before - all of those are one line here and an
 * afternoon of luck against a live socket.
 *
 * The shapes follow OpenAI's Realtime API as of writing. When Phase 5 records
 * what actually arrives, this file is what gets corrected - and the reducer
 * tests will say exactly what changed.
 */

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

/** The learner's speech, as the input transcription model reports it. */
export function userDelta(itemId: string, delta: string): RealtimeEvent {
  return { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta }
}

export function userDone(itemId: string, transcript: string): RealtimeEvent {
  return { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript }
}

/** What the coach said out loud. */
export function assistantDelta(itemId: string, delta: string): RealtimeEvent {
  return { type: 'response.output_audio_transcript.delta', item_id: itemId, delta }
}

export function assistantDone(itemId: string, transcript: string): RealtimeEvent {
  return { type: 'response.output_audio_transcript.done', item_id: itemId, transcript }
}

/** A text-only response, which is what the wrap-up turn asks for. */
export function assistantTextDelta(itemId: string, delta: string): RealtimeEvent {
  return { type: 'response.output_text.delta', item_id: itemId, delta }
}

export function assistantTextDone(itemId: string, text: string): RealtimeEvent {
  return { type: 'response.output_text.done', item_id: itemId, text }
}

export function toolDelta(callId: string, name: string, delta: string): RealtimeEvent {
  return { type: 'response.function_call_arguments.delta', call_id: callId, item_id: callId, name, delta }
}

export function toolDone(callId: string, name: string, args?: string): RealtimeEvent {
  return {
    type: 'response.function_call_arguments.done',
    call_id: callId,
    item_id: callId,
    name,
    ...(args === undefined ? {} : { arguments: args })
  }
}

export function responseCreated(responseId: string): RealtimeEvent {
  return { type: 'response.created', response: { id: responseId } }
}

export function responseDone(responseId: string, functionCalls = 0): RealtimeEvent {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      output: Array.from({ length: functionCalls }, (_, n) => ({ type: 'function_call', call_id: `call_${n}` }))
    }
  }
}

export function errorEvent(message: string): RealtimeEvent {
  return { type: 'error', error: { type: 'invalid_request_error', message } }
}

/** Events that really do arrive and that the reducer has nothing to do with. */
export const NOISE: readonly RealtimeEvent[] = [
  { type: 'session.created', session: { id: 'sess_1' } },
  { type: 'session.updated', session: { id: 'sess_1' } },
  { type: 'input_audio_buffer.speech_started', item_id: 'item_x' },
  { type: 'input_audio_buffer.speech_stopped', item_id: 'item_x' },
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'rate_limits.updated', rate_limits: [] }
]

/**
 * The exact bookkeeping vocabulary of a real session, with the counts it
 * produced - recorded 2026-09-14 from gpt-realtime-2.1 over WebRTC.
 *
 * It is here because the first version of the diagnostics panel reported every
 * one of these as possible drift, which meant it cried wolf in every session
 * anyone ever ran. None of these may ever be `unknown` again.
 */
export const OBSERVED_BOOKKEEPING: readonly (readonly [string, number])[] = [
  ['session.created', 1],
  ['input_audio_buffer.speech_started', 3],
  ['input_audio_buffer.speech_stopped', 3],
  ['input_audio_buffer.committed', 3],
  ['conversation.item.added', 10],
  ['conversation.item.done', 10],
  ['response.output_item.added', 6],
  ['response.content_part.added', 5],
  ['output_audio_buffer.started', 5],
  ['response.output_audio.done', 5],
  ['response.content_part.done', 5],
  ['response.output_item.done', 6],
  ['rate_limits.updated', 4],
  ['output_audio_buffer.stopped', 1],
  ['output_audio_buffer.cleared', 1],
  ['conversation.item.truncated', 1]
]

/** Every one of the above, repeated as many times as it really arrived. */
export function observedBookkeeping(): RealtimeEvent[] {
  const out: RealtimeEvent[] = []
  for (const [type, count] of OBSERVED_BOOKKEEPING) {
    for (let n = 0; n < count; n += 1) out.push({ type, item_id: `item_${n}` })
  }
  return out
}

/** A completed conversation item, which carries the whole message. */
export function itemDone(
  itemId: string,
  role: 'user' | 'assistant',
  transcript: string,
  type = 'message'
): RealtimeEvent {
  return {
    type: 'conversation.item.done',
    item: {
      id: itemId,
      type,
      role,
      content: [{ type: role === 'user' ? 'input_audio' : 'audio', transcript }]
    }
  }
}

/** Splits a string into chunks, the way a stream of deltas arrives. */
export function chunks(text: string, size = 4): string[] {
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}

/** One complete spoken exchange, delta by delta. */
export function exchange(userItem: string, said: string, coachItem: string, replied: string): RealtimeEvent[] {
  return [
    ...chunks(said).map((chunk) => userDelta(userItem, chunk)),
    userDone(userItem, said),
    ...chunks(replied).map((chunk) => assistantDelta(coachItem, chunk)),
    assistantDone(coachItem, replied)
  ]
}
