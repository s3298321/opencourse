/**
 * The Realtime API's event stream, folded into a transcript and a list of
 * things to do.
 *
 * This is the piece that makes the whole feature testable without a socket:
 * given a recorded stream of events, the transcript and the tool calls that
 * come out are a pure function of them. The renderer's job shrinks to "parse
 * JSON, call this, act on the effects".
 *
 * Three rules, all of which exist because OpenAI renames things:
 *
 * 1. It never throws. A malformed or unrecognised event produces an `unknown`
 *    effect and is otherwise ignored, so a rename costs a missing transcript
 *    line rather than a dead session.
 * 2. Event types are matched by shape as well as by name. The exact strings
 *    below were right when this was written; the suffix matching underneath
 *    them is what survives the next rename.
 * 3. `unknown` means *actually* unknown. A normal session produces a couple of
 *    dozen bookkeeping events this reducer has no use for; those are matched by
 *    BENIGN_PREFIXES and counted as `ignored`. An alarm that fires every session
 *    is not an alarm, and the first version of this shipped exactly that bug.
 */
import type { TranscriptTurn } from '../types'

export interface PendingToolCall {
  callId: string
  name: string
  /** Raw JSON as the model sent it; parseToolCall in tools.ts validates it. */
  arguments: string
}

export type SessionEffect =
  | { kind: 'turn'; turn: TranscriptTurn }
  | { kind: 'partial'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; call: PendingToolCall }
  | { kind: 'error'; message: string }
  | { kind: 'responseStarted'; responseId: string }
  | { kind: 'responseDone'; responseId: string; toolCallCount: number; status?: string; reason?: string }
  | { kind: 'unknown'; type: string }

interface OpenItem {
  seq: number
  role: 'user' | 'assistant'
  text: string
}

interface OpenCall {
  callId: string
  name: string
  arguments: string
}

export interface SessionState {
  /** Next conversational position. Assigned when an item is first seen. */
  nextSeq: number
  items: Record<string, OpenItem>
  calls: Record<string, OpenCall>
  /** Completed turns, in conversational order. */
  turns: TranscriptTurn[]
  /** item ids already turned into a turn, so a repeated .done cannot double up. */
  closed: string[]
  /** call ids already emitted, for the same reason. */
  dispatched: string[]
  /** Event types seen that this reducer has no case for. A drift alarm. */
  unknown: Record<string, number>
  /** Known protocol chatter. Counted for diagnostics, never alarming. */
  ignored: Record<string, number>
}

export function emptySessionState(): SessionState {
  return { nextSeq: 0, items: {}, calls: {}, turns: [], closed: [], dispatched: [], unknown: {}, ignored: {} }
}

const MAX_TRACKED_IDS = 500

/**
 * Protocol events that are entirely expected and carry nothing this reducer
 * needs. Every one of these arrives in a normal session - the list was taken
 * from a real one - and counting them as drift meant the diagnostics panel
 * cried wolf in every session it was ever shown.
 *
 * A prefix entry covers a family whose members are all bookkeeping. Anything
 * *not* matched here is genuinely unrecognised and worth surfacing.
 */
const BENIGN_PREFIXES = [
  'session.',
  'input_audio_buffer.',
  'output_audio_buffer.',
  'rate_limits.',
  'response.output_item.',
  'response.content_part.',
  'response.output_audio.',
  'conversation.item.added',
  'conversation.item.created',
  'conversation.item.truncated',
  'conversation.item.deleted',
  'conversation.item.retrieved',
  'transcription_session.'
] as const

function isBenign(type: string): boolean {
  return BENIGN_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/** The text of a conversation item, wherever its content parts put it. */
function itemText(item: Record<string, unknown>): string {
  const content = item['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    const text = record['transcript'] ?? record['text']
    if (typeof text === 'string' && text) parts.push(text)
  }
  return parts.join(' ').trim()
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The delta text, wherever this particular event decided to put it. */
function textOf(event: Record<string, unknown>): string {
  for (const field of ['delta', 'transcript', 'text']) {
    const value = event[field]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** Which side of the conversation an event is about, from its type. */
function roleOf(type: string): 'user' | 'assistant' | null {
  // The learner's own speech, transcribed by the input transcription model.
  if (type.includes('input_audio_transcription')) return 'user'
  // Anything the model produced: spoken transcript or plain text.
  if (type.includes('output_audio_transcript') || type.includes('audio_transcript')) return 'assistant'
  if (type.includes('output_text') || type.includes('.text.')) return 'assistant'
  return null
}

function isDelta(type: string): boolean {
  return type.endsWith('.delta')
}

function isFinished(type: string): boolean {
  return type.endsWith('.done') || type.endsWith('.completed')
}

function remember(list: string[], id: string): string[] {
  const next = [...list, id]
  return next.length > MAX_TRACKED_IDS ? next.slice(next.length - MAX_TRACKED_IDS) : next
}

function trim(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map)
  if (keys.length <= 50) return map
  const out: Record<string, number> = {}
  for (const key of keys.slice(keys.length - 50)) out[key] = map[key] as number
  return out
}

/**
 * Folds one event into the session.
 *
 * `at` is injected so a test can pin timestamps, the way core/progress.ts takes
 * a `now`.
 */
export function reduceRealtimeEvent(
  state: SessionState,
  raw: unknown,
  at: string = new Date().toISOString()
): { state: SessionState; effects: SessionEffect[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state, effects: [{ kind: 'unknown', type: 'not-an-object' }] }
  }
  const event = raw as Record<string, unknown>
  const type = str(event['type'])
  if (!type) return { state, effects: [{ kind: 'unknown', type: 'no-type' }] }

  /* --- errors ----------------------------------------------------------- */

  if (type === 'error' || type.endsWith('.error') || type.endsWith('.failed')) {
    const detail = event['error']
    const message =
      (detail && typeof detail === 'object' ? str((detail as Record<string, unknown>)['message']) : '') ||
      str(event['message']) ||
      'the session reported an error'
    return { state, effects: [{ kind: 'error', message }] }
  }

  /* --- tool calls -------------------------------------------------------- */

  if (type.includes('function_call_arguments')) {
    const callId = str(event['call_id']) || str(event['item_id'])
    if (!callId) return { state, effects: [{ kind: 'unknown', type }] }

    const open: OpenCall = state.calls[callId] ?? {
      callId: str(event['call_id']) || callId,
      name: str(event['name']),
      arguments: ''
    }
    // The name can arrive on any event in the run, not only the first.
    const name = str(event['name']) || open.name

    if (isDelta(type)) {
      const calls = { ...state.calls, [callId]: { ...open, name, arguments: open.arguments + textOf(event) } }
      return { state: { ...state, calls }, effects: [] }
    }
    if (isFinished(type)) {
      // A repeated .done must not run the tool twice.
      if (state.dispatched.includes(callId)) return { state, effects: [] }
      const args = str(event['arguments']) || open.arguments
      const calls = { ...state.calls }
      delete calls[callId]
      return {
        state: { ...state, calls, dispatched: remember(state.dispatched, callId) },
        effects: [{ kind: 'tool', call: { callId: open.callId, name, arguments: args } }]
      }
    }
    return { state, effects: [{ kind: 'unknown', type }] }
  }

  /* --- transcripts ------------------------------------------------------- */

  const role = roleOf(type)
  if (role && (isDelta(type) || isFinished(type))) {
    const itemId = str(event['item_id']) || str(event['response_id']) || `${role}-${state.nextSeq}`
    if (state.closed.includes(itemId)) return { state, effects: [] }

    let next = state
    let open = state.items[itemId]
    if (!open) {
      // Position is fixed when an item is first seen, so the transcript reads
      // in the order things were said - not the order they finished.
      open = { seq: state.nextSeq, role, text: '' }
      next = { ...state, nextSeq: state.nextSeq + 1, items: { ...state.items, [itemId]: open } }
    }

    if (isDelta(type)) {
      const text = open.text + textOf(event)
      return {
        state: { ...next, items: { ...next.items, [itemId]: { ...open, text } } },
        effects: [{ kind: 'partial', role, text }]
      }
    }

    // Finished. A repeated .done must not append the turn twice.
    if (next.closed.includes(itemId)) return { state: next, effects: [] }
    // The final event usually carries the whole transcript; prefer it to the
    // deltas, which can drop one.
    const final = ['transcript', 'text'].map((field) => event[field]).find((value) => typeof value === 'string')
    const text = (typeof final === 'string' ? final : textOf(event) || open.text).trim()
    const items = { ...next.items }
    delete items[itemId]
    const closed = remember(next.closed, itemId)
    if (!text) return {
      state: { ...next, items, closed },
      effects: open.text ? [{ kind: 'partial', role, text: '' }] : []
    }

    const turn: TranscriptTurn = { seq: open.seq, role, text, at }
    return {
      state: { ...next, items, closed, turns: [...next.turns, turn] },
      effects: [{ kind: 'turn', turn }]
    }
  }

  /* --- a completed conversation item -------------------------------------- */

  /*
   * A belt-and-braces path for the transcript. `conversation.item.done` carries
   * the whole item, transcript included, so a session still produces a
   * transcript even if the dedicated transcription events are renamed out from
   * under us. The `closed` set means an item that already became a turn the
   * normal way is ignored here, so this cannot double up.
   */
  if (type === 'conversation.item.done' || type === 'conversation.item.completed') {
    const ignore = (): { state: SessionState; effects: SessionEffect[] } => ({
      state: { ...state, ignored: trim({ ...state.ignored, [type]: (state.ignored[type] ?? 0) + 1 }) },
      effects: []
    })

    // A recognised event with nothing in it for us is still recognised. Only an
    // event type we have never heard of is drift.
    const item = event['item']
    if (!item || typeof item !== 'object') return ignore()
    const record = item as Record<string, unknown>

    // Function calls have their own path; only messages are transcript.
    if (str(record['type']) !== 'message') return ignore()

    const itemId = str(record['id']) || str(event['item_id'])
    const itemRole = str(record['role']) === 'user' ? 'user' : 'assistant'
    const text = itemText(record)
    // Already a turn by the normal route, or nothing said: nothing to add.
    if (!itemId || !text || state.closed.includes(itemId)) return ignore()

    const open = state.items[itemId]
    const seq = open ? open.seq : state.nextSeq
    const items = { ...state.items }
    delete items[itemId]
    const turn: TranscriptTurn = { seq, role: itemRole, text, at }
    return {
      state: {
        ...state,
        nextSeq: open ? state.nextSeq : state.nextSeq + 1,
        items,
        closed: remember(state.closed, itemId),
        turns: [...state.turns, turn]
      },
      effects: [{ kind: 'turn', turn }]
    }
  }

  /* --- a response starting and finishing ---------------------------------- */

  /*
   * Flow control, not transcript: the Realtime API allows exactly one active
   * response at a time, and `response.create` while one is running is refused.
   * The transport tracks this pair so it can hold a request back rather than
   * have it rejected.
   */
  if (type === 'response.created') {
    const response = event['response']
    const responseId =
      (response && typeof response === 'object' ? str((response as Record<string, unknown>)['id']) : '') ||
      str(event['response_id'])
    return { state, effects: [{ kind: 'responseStarted', responseId }] }
  }

  if (type === 'response.done' || type === 'response.completed') {
    const response = event['response']
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
    const status = str(record['status'])
    const details = record['status_details']
    const detail = details && typeof details === 'object' ? details as Record<string, unknown> : {}
    const error = detail['error']
    const reason = (error && typeof error === 'object' ? str((error as Record<string, unknown>)['message']) : '') || str(detail['reason'])
    const output =
      response && typeof response === 'object' ? (response as Record<string, unknown>)['output'] : undefined
    const toolCallCount = Array.isArray(output)
      ? output.filter(
          (item) =>
            item && typeof item === 'object' && str((item as Record<string, unknown>)['type']).includes('function_call')
        ).length
      : 0
    const responseId =
      (response && typeof response === 'object' ? str((response as Record<string, unknown>)['id']) : '') ||
      str(event['response_id'])
    return { state, effects: [{ kind: 'responseDone', responseId, toolCallCount, ...(status ? { status } : {}), ...(reason ? { reason } : {}) }] }
  }

  /* --- everything else ---------------------------------------------------- */

  // Known bookkeeping: counted, but never presented as a problem.
  if (isBenign(type)) {
    const ignored = trim({ ...state.ignored, [type]: (state.ignored[type] ?? 0) + 1 })
    return { state: { ...state, ignored }, effects: [] }
  }

  // Genuinely unrecognised. This is the drift alarm, and it should stay quiet
  // in a normal session - if it fires, something really was renamed.
  const unknown = trim({ ...state.unknown, [type]: (state.unknown[type] ?? 0) + 1 })
  return { state: { ...state, unknown }, effects: [{ kind: 'unknown', type }] }
}

/** The transcript so far, in conversational order. */
export function transcriptOf(state: SessionState): TranscriptTurn[] {
  return [...state.turns].sort((a, b) => a.seq - b.seq)
}

/**
 * Turns still in flight, as provisional entries. Used when a session is cut off
 * and half-finished speech is better than nothing.
 */
export function pendingTurns(state: SessionState, at: string = new Date().toISOString()): TranscriptTurn[] {
  return Object.values(state.items)
    .filter((item) => item.text.trim())
    .map((item) => ({ seq: item.seq, role: item.role, text: item.text.trim(), at }))
    .sort((a, b) => a.seq - b.seq)
}
