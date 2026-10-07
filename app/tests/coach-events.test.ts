/**
 * The realtime event reducer.
 *
 * This is where the session is actually specified. Everything downstream - the
 * transcript in the database, the tool calls that write files, the wrap-up -
 * is a consequence of what comes out of here, and all of it can be checked
 * without a socket, a key, or a microphone.
 */
import { describe, expect, it } from 'vitest'
import { emptySessionState, pendingTurns, reduceRealtimeEvent, transcriptOf } from '@core/coach/events'
import type { SessionEffect, SessionState } from '@core/coach/events'
import {
  NOISE,
  OBSERVED_BOOKKEEPING,
  itemDone,
  observedBookkeeping,
  assistantDelta,
  assistantDone,
  assistantTextDelta,
  assistantTextDone,
  chunks,
  errorEvent,
  exchange,
  responseCreated,
  responseDone,
  toolDelta,
  toolDone,
  userDelta,
  userDone
} from './helpers/realtime-events'

const AT = '2026-09-14T10:00:00.000Z'

/** Feeds a whole stream in, the way the data channel would. */
function run(events: readonly unknown[], from: SessionState = emptySessionState()): {
  state: SessionState
  effects: SessionEffect[]
} {
  let state = from
  const effects: SessionEffect[] = []
  for (const event of events) {
    const step = reduceRealtimeEvent(state, event, AT)
    state = step.state
    effects.push(...step.effects)
  }
  return { state, effects }
}

const kinds = (effects: readonly SessionEffect[], kind: string): SessionEffect[] =>
  effects.filter((effect) => effect.kind === kind)

describe('assembling a transcript', () => {
  it('turns a stream of deltas into one turn', () => {
    const { state } = run([...chunks('bonjour, comment ça va').map((c) => userDelta('item_1', c)), userDone('item_1', 'bonjour, comment ça va')])
    expect(transcriptOf(state)).toEqual([{ seq: 0, role: 'user', text: 'bonjour, comment ça va', at: AT }])
  })

  it('keeps both sides of an exchange, in the order they were said', () => {
    const { state } = run(exchange('item_1', 'bonjour', 'item_2', 'salut, on commence ?'))
    expect(transcriptOf(state).map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'bonjour'],
      ['assistant', 'salut, on commence ?']
    ])
  })

  it('orders turns by when they started, not when they finished', () => {
    // The learner starts talking first, but their transcription lands last -
    // which is the normal case, and the one that reads wrong if you use
    // completion order.
    const { state } = run([
      userDelta('item_1', 'et le mot pour'),
      assistantDelta('item_2', 'je t’écoute'),
      assistantDone('item_2', 'je t’écoute'),
      userDone('item_1', 'et le mot pour "book" ?')
    ])
    expect(transcriptOf(state).map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(transcriptOf(state).map((turn) => turn.seq)).toEqual([0, 1])
  })

  it('prefers the final transcript over the deltas, which can drop one', () => {
    const { state } = run([
      userDelta('item_1', 'bon'),
      userDelta('item_1', 'jou'),
      userDone('item_1', 'bonjour tout le monde')
    ])
    expect(transcriptOf(state)[0]?.text).toBe('bonjour tout le monde')
  })

  it('reports partials as they arrive, so the screen can keep up', () => {
    const { effects } = run([userDelta('item_1', 'bon'), userDelta('item_1', 'jour')])
    expect(kinds(effects, 'partial')).toEqual([
      { kind: 'partial', role: 'user', text: 'bon' },
      { kind: 'partial', role: 'user', text: 'bonjour' }
    ])
  })

  it('does not append a turn twice when .done arrives again', () => {
    const { state } = run([userDelta('item_1', 'bonjour'), userDone('item_1', 'bonjour'), userDone('item_1', 'bonjour')])
    expect(transcriptOf(state)).toHaveLength(1)
  })

  it('drops an item that finished with nothing in it', () => {
    const { state, effects } = run([userDelta('item_1', '   '), userDone('item_1', '  ')])
    expect(transcriptOf(state)).toHaveLength(0)
    expect(kinds(effects, 'turn')).toHaveLength(0)
  })

  it('handles a text-only response, which is what the wrap-up asks for', () => {
    const { state } = run([assistantTextDelta('item_9', 'saved'), assistantTextDone('item_9', 'saved.')])
    expect(transcriptOf(state)).toEqual([{ seq: 0, role: 'assistant', text: 'saved.', at: AT }])
  })

  it('keeps a long conversation in order', () => {
    const events = []
    for (let n = 0; n < 8; n += 1) events.push(...exchange(`u${n}`, `question ${n}`, `a${n}`, `answer ${n}`))
    const { state } = run(events)
    const turns = transcriptOf(state)
    expect(turns).toHaveLength(16)
    expect(turns.map((turn) => turn.seq)).toEqual([...Array(16).keys()])
    expect(turns[14]?.text).toBe('question 7')
    expect(turns[15]?.text).toBe('answer 7')
  })
})

describe('tool calls', () => {
  it('assembles one from its argument deltas and emits it exactly once', () => {
    const args = JSON.stringify({ path: 'learned.md', content: '- le livre\n' })
    const { effects } = run([
      ...chunks(args, 7).map((chunk) => toolDelta('call_1', 'write_file', chunk)),
      toolDone('call_1', 'write_file')
    ])
    expect(kinds(effects, 'tool')).toEqual([
      { kind: 'tool', call: { callId: 'call_1', name: 'write_file', arguments: args } }
    ])
  })

  it('prefers the arguments on the done event when it carries them', () => {
    const whole = JSON.stringify({ path: 'review.md', content: 'etre' })
    const { effects } = run([toolDelta('call_1', 'write_file', '{"pa'), toolDone('call_1', 'write_file', whole)])
    const tool = kinds(effects, 'tool')[0]
    expect(tool && tool.kind === 'tool' && tool.call.arguments).toBe(whole)
  })

  it('does not run a tool twice when .done arrives again', () => {
    const { effects } = run([
      toolDelta('call_1', 'write_file', '{}'),
      toolDone('call_1', 'write_file'),
      toolDone('call_1', 'write_file')
    ])
    expect(kinds(effects, 'tool')).toHaveLength(1)
  })

  it('keeps two calls in the same response apart', () => {
    const { effects } = run([
      toolDelta('call_1', 'write_file', '{"path":"a.md",'),
      toolDelta('call_2', 'append_file', '{"path":"b.md",'),
      toolDelta('call_1', 'write_file', '"content":"one"}'),
      toolDelta('call_2', 'append_file', '"content":"two"}'),
      toolDone('call_1', 'write_file'),
      toolDone('call_2', 'append_file')
    ])
    const tools = kinds(effects, 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.map((effect) => (effect.kind === 'tool' ? effect.call.arguments : ''))).toEqual([
      '{"path":"a.md","content":"one"}',
      '{"path":"b.md","content":"two"}'
    ])
  })

  it('still emits a call whose name only arrived on the done event', () => {
    const { effects } = run([toolDelta('call_1', '', '{}'), toolDone('call_1', 'list_files')])
    const tool = kinds(effects, 'tool')[0]
    expect(tool && tool.kind === 'tool' && tool.call.name).toBe('list_files')
  })

  it('emits a truncated call rather than swallowing it, for the parser to refuse', () => {
    // The model got cut off. tools.ts turns this into a message it can retry from.
    const { effects } = run([toolDelta('call_1', 'write_file', '{"path":"a.m'), toolDone('call_1', 'write_file')])
    const tool = kinds(effects, 'tool')[0]
    expect(tool && tool.kind === 'tool' && tool.call.arguments).toBe('{"path":"a.m')
  })

  it('does not mistake a tool call for something the learner said', () => {
    const { state } = run([toolDelta('call_1', 'write_file', '{}'), toolDone('call_1', 'write_file')])
    expect(transcriptOf(state)).toHaveLength(0)
  })
})

describe('a response finishing', () => {
  it('says how many tool calls it produced, which is what the wrap-up waits on', () => {
    const { effects } = run([responseDone('resp_1', 2)])
    expect(kinds(effects, 'responseDone')).toEqual([{ kind: 'responseDone', responseId: 'resp_1', toolCallCount: 2 }])
  })

  it('reports zero when the model answered in words instead of saving', () => {
    const { effects } = run([responseDone('resp_2', 0)])
    const done = kinds(effects, 'responseDone')[0]
    expect(done && done.kind === 'responseDone' && done.toolCallCount).toBe(0)
  })
})

describe('errors and drift', () => {
  it('surfaces an error without ending the session', () => {
    const { effects, state } = run([errorEvent('you are sending audio too fast'), ...exchange('u', 'hi', 'a', 'hello')])
    expect(kinds(effects, 'error')).toEqual([{ kind: 'error', message: 'you are sending audio too fast' }])
    // The conversation carried on, which is the point: not every error is fatal.
    expect(transcriptOf(state)).toHaveLength(2)
  })

  it('files known bookkeeping as ignored, not as drift', () => {
    const { state, effects } = run(NOISE)
    expect(kinds(effects, 'unknown')).toHaveLength(0)
    expect(state.unknown).toEqual({})
    expect(state.ignored['session.created']).toBe(1)
    expect(transcriptOf(state)).toHaveLength(0)
  })

  it('counts an event type it has never heard of instead of failing on it', () => {
    const { state, effects } = run([{ type: 'response.telepathy.delta' }, { type: 'response.telepathy.delta' }])
    expect(kinds(effects, 'unknown')).toHaveLength(2)
    expect(state.unknown['response.telepathy.delta']).toBe(2)
  })

  it('never throws, whatever arrives', () => {
    const nasty: unknown[] = [
      null,
      undefined,
      42,
      'a string',
      [],
      {},
      { type: '' },
      { type: 'response.output_audio_transcript.delta' },
      { type: 'response.function_call_arguments.done' },
      { type: 'error' },
      { type: 'response.done', response: 'not an object' },
      { type: 'response.done', response: { output: 'not an array' } },
      { type: 'conversation.item.input_audio_transcription.delta', item_id: 5, delta: 7 }
    ]
    for (const event of nasty) {
      expect(() => reduceRealtimeEvent(emptySessionState(), event, AT)).not.toThrow()
    }
  })

  it('carries on after a nonsense event, mid-turn', () => {
    const { state } = run([
      userDelta('item_1', 'bon'),
      { type: 'something.nobody.has.seen' },
      null,
      userDelta('item_1', 'jour'),
      userDone('item_1', 'bonjour')
    ])
    expect(transcriptOf(state)[0]?.text).toBe('bonjour')
  })

  it('keeps a renamed transcript event working, because the role is read from its shape', () => {
    // If OpenAI moves the prefix, the suffix and the word still carry it.
    const renamed = { type: 'response.assistant_audio_transcript.done', item_id: 'x', transcript: 'salut' }
    const { state } = run([renamed])
    expect(transcriptOf(state)).toEqual([{ seq: 0, role: 'assistant', text: 'salut', at: AT }])
  })

  it('does not let a flood of unknown types grow without bound', () => {
    const events = Array.from({ length: 300 }, (_, n) => ({ type: `made.up.${n}` }))
    const { state } = run(events)
    expect(Object.keys(state.unknown).length).toBeLessThanOrEqual(50)
  })
})

describe('a session cut off mid-sentence', () => {
  it('offers what was said but never completed, rather than losing it', () => {
    const { state } = run([
      ...exchange('item_1', 'bonjour', 'item_2', 'salut'),
      userDelta('item_3', 'et comment dit-on')
    ])
    expect(transcriptOf(state)).toHaveLength(2)
    expect(pendingTurns(state, AT)).toEqual([{ seq: 2, role: 'user', text: 'et comment dit-on', at: AT }])
  })

  it('offers nothing when there is nothing half-said', () => {
    const { state } = run(exchange('item_1', 'bonjour', 'item_2', 'salut'))
    expect(pendingTurns(state, AT)).toEqual([])
  })
})

describe('the drift alarm, after it cried wolf', () => {
  it('stays silent through the bookkeeping of a real session', () => {
    // The first version reported all seventeen of these as possible drift, in
    // every session. An alarm that always fires is not an alarm.
    const { state, effects } = run(observedBookkeeping())

    expect(state.unknown).toEqual({})
    expect(kinds(effects, 'unknown')).toHaveLength(0)
    expect(Object.keys(state.ignored).length).toBe(OBSERVED_BOOKKEEPING.length)
  })

  it('counts the bookkeeping rather than throwing it away', () => {
    const { state } = run(observedBookkeeping())
    for (const [type, count] of OBSERVED_BOOKKEEPING) {
      expect(state.ignored[type]).toBe(count)
    }
  })

  it('still fires for something genuinely new', () => {
    const { state, effects } = run([...observedBookkeeping(), { type: 'response.hologram.delta' }])
    expect(state.unknown).toEqual({ 'response.hologram.delta': 1 })
    expect(kinds(effects, 'unknown')).toHaveLength(1)
  })

  it('does not let bookkeeping invent a turn', () => {
    const { state } = run(observedBookkeeping())
    expect(transcriptOf(state)).toHaveLength(0)
  })
})

describe('conversation.item.done as a second route to the transcript', () => {
  it('produces a turn when the dedicated transcription events never arrive', () => {
    // What a rename of the transcription events would look like.
    const { state } = run([
      itemDone('item_1', 'user', 'bonjour, je veux apprendre'),
      itemDone('item_2', 'assistant', 'tres bien, commencons')
    ])
    expect(transcriptOf(state).map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'bonjour, je veux apprendre'],
      ['assistant', 'tres bien, commencons']
    ])
  })

  it('does not double up when the normal route already produced the turn', () => {
    const { state } = run([
      userDelta('item_1', 'bonjour'),
      userDone('item_1', 'bonjour'),
      itemDone('item_1', 'user', 'bonjour')
    ])
    expect(transcriptOf(state)).toHaveLength(1)
  })

  it('keeps the position the item already had, rather than appending it at the end', () => {
    const { state } = run([
      userDelta('item_1', 'et le mot pour'),
      assistantDelta('item_2', 'oui ?'),
      assistantDone('item_2', 'oui ?'),
      itemDone('item_1', 'user', 'et le mot pour "book" ?')
    ])
    expect(transcriptOf(state).map((turn) => turn.role)).toEqual(['user', 'assistant'])
  })

  it('leaves function calls to the tool path', () => {
    const { state, effects } = run([itemDone('call_1', 'assistant', '', 'function_call')])
    expect(transcriptOf(state)).toHaveLength(0)
    expect(kinds(effects, 'tool')).toHaveLength(0)
  })

  it('ignores an item with nothing in it', () => {
    const { state } = run([itemDone('item_1', 'user', '')])
    expect(transcriptOf(state)).toHaveLength(0)
  })
})


describe('one response at a time', () => {
  it('reports a response starting, which is what stops a second request being refused', () => {
    // The API allows exactly one active response; the transport needs both
    // ends of the pair to know when it may ask for another.
    const { effects } = run([responseCreated('resp_1'), responseDone('resp_1', 3)])
    expect(effects.map((effect) => effect.kind)).toEqual(['responseStarted', 'responseDone'])
  })

  it('carries the response id on both, so they can be matched up', () => {
    const { effects } = run([responseCreated('resp_EO3VSI'), responseDone('resp_EO3VSI', 0)])
    const started = effects[0]
    expect(started && started.kind === 'responseStarted' && started.responseId).toBe('resp_EO3VSI')
  })

  it('counts the tool calls a response produced, which is what a batch means', () => {
    // Three files written in one turn: one batch, and so one reply asked for.
    const { effects } = run([responseCreated('resp_1'), responseDone('resp_1', 3)])
    const done = effects[1]
    expect(done && done.kind === 'responseDone' && done.toolCallCount).toBe(3)
  })
})
