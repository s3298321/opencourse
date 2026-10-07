/**
 * The one-response-at-a-time rule.
 *
 * This exists because of a real bug: `response.create` was sent per finished
 * tool call, so a coach writing its three memory files in one turn produced
 * three requests. The first started a response and OpenAI refused the other
 * two — "Conversation already has an active response in progress" — which
 * showed up in the live panel as error chips between the writes.
 */
import { describe, expect, it } from 'vitest'
import { ResponseGate } from '@core/coach/responses'

/** A gate wired to a recorder, so "what went down the channel" is the assertion. */
function gate(): { gate: ResponseGate; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return { gate: new ResponseGate((payload) => sent.push(payload)), sent }
}

const creates = (sent: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
  sent.filter((payload) => payload['type'] === 'response.create')

describe('a batch of tool calls', () => {
  it('asks for exactly one reply when the coach writes three files in one turn', () => {
    // The shape of the bug, verbatim: context.md, learned.md, review.md.
    const { gate: g, sent } = gate()
    g.started()
    g.toolStarted()
    g.toolStarted()
    g.toolStarted()
    g.done()

    expect(g.toolFinished()).toBe(false)
    expect(g.toolFinished()).toBe(false)
    expect(g.toolFinished()).toBe(true)

    expect(creates(sent)).toHaveLength(1)
  })

  it('asks once for a single tool call too', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.toolStarted()
    g.done()
    expect(g.toolFinished()).toBe(true)
    expect(creates(sent)).toHaveLength(1)
  })

  it('does not ask while a response is still running', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.toolStarted()
    g.toolFinished()

    expect(creates(sent)).toHaveLength(0)
    g.done()
    expect(creates(sent)).toHaveLength(1)
  })

  it('asks again for the next batch, so the conversation keeps going', () => {
    const { gate: g, sent } = gate()
    for (let turn = 0; turn < 3; turn += 1) {
      g.started()
      g.toolStarted()
      g.done()
      g.toolFinished()
    }
    expect(creates(sent)).toHaveLength(3)
  })

  it('survives tools finishing out of order and at different speeds', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.toolStarted()
    g.toolFinished() // a fast one lands before its siblings are even registered
    g.toolStarted()
    g.toolStarted()
    g.done()
    g.toolFinished()
    g.toolFinished()

    // Two batches by the gate's reckoning, and never two at once.
    expect(creates(sent).length).toBeLessThanOrEqual(2)
    expect(creates(sent).length).toBeGreaterThan(0)
  })

  it('never counts below zero when a tool reports twice', () => {
    const { gate: g, sent } = gate()
    g.toolStarted()
    g.toolFinished()
    g.toolFinished()
    expect(g.outstandingTools).toBe(0)
    g.done()
    expect(creates(sent)).toHaveLength(1)
  })
})

describe('holding a request back', () => {
  it('keeps at most one held request, rather than a queue that all fires at once', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.request({ output_modalities: ['text'] })
    g.request({ output_modalities: ['text'] })
    g.request({ output_modalities: ['text'] })
    expect(creates(sent)).toHaveLength(0)

    g.done()
    expect(creates(sent)).toHaveLength(1)
  })

  it('sends the held request with the options it was asked for', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.request({ output_modalities: ['text'], tool_choice: { type: 'function', name: 'write_file' } })
    g.done()

    const created = creates(sent)[0] as { response: Record<string, unknown> }
    expect(created.response['output_modalities']).toEqual(['text'])
    expect(created.response['tool_choice']).toEqual({ type: 'function', name: 'write_file' })
  })

  it('omits the response object entirely when there is nothing to say about it', () => {
    const { gate: g, sent } = gate()
    g.request()
    expect(creates(sent)[0]).toEqual({ type: 'response.create' })
  })

  it('leaves a held request to the tool that is still running', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.toolStarted()
    g.request({ output_modalities: ['text'] })
    g.done()

    // The tool will ask when it lands; asking now would be refused anyway.
    expect(creates(sent)).toHaveLength(0)
    g.toolFinished()
    expect(creates(sent)).toHaveLength(1)
    expect(creates(sent)[0]).toEqual({ type: 'response.create', response: { output_modalities: ['text'] } })
  })

  it('tracks a response it did not ask for, so a refusal cannot follow', () => {
    // The coach answers the learner on its own; nothing here requested it.
    const { gate: g, sent } = gate()
    g.started()
    expect(g.busy).toBe(true)

    g.request()
    expect(creates(sent)).toHaveLength(0)
  })
})

describe('learner interruptions', () => {
  it('lets automatic VAD cancel a reply without sending a duplicate cancel or continuation', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    const generation = g.toolStarted()
    g.speechStarted()
    g.done('old')
    g.toolFinished(generation)
    g.speechStopped()
    g.started('new')
    expect(sent).toEqual([])
    expect(g.busy).toBe(true)
  })

  it('does not send a held tool continuation while the learner is still speaking', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    g.speechStarted()
    g.request()
    g.done('old')
    expect(sent).toEqual([])
    g.speechStopped()
    // The server creates the response, rather than releasing this old request.
    g.started('new')
    g.done('new')
    expect(sent).toEqual([])
  })
  it('cancels once and waits for the cancelled response to finish before answering new speech', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    g.interrupt()
    g.interrupt()
    g.request()
    expect(sent).toEqual([{ type: 'response.cancel', response_id: 'old' }])
    g.done('old')
    expect(creates(sent)).toHaveLength(1)
    g.started('new')
    g.done('old') // duplicate completion must not release another response
    expect(g.busy).toBe(true)
  })

  it('drops a cancelled tool continuation while keeping the write itself accounted for', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    const generation = g.toolStarted()
    g.interrupt()
    g.done('old')
    g.toolFinished(generation)
    expect(creates(sent)).toHaveLength(0)
    expect(g.outstandingTools).toBe(0)
  })

  it('does not revive a tool whose arguments finish arriving after the interruption', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    g.interrupt()
    const generation = g.toolStarted()
    g.done('old')
    g.toolFinished(generation)
    expect(creates(sent)).toHaveLength(0)
  })

  it('holds the new learner response until interrupted writes land, then sends it once', () => {
    const { gate: g, sent } = gate()
    g.started('old')
    const generation = g.toolStarted()
    g.interrupt()
    g.request()
    g.done('old')
    expect(creates(sent)).toHaveLength(0)
    g.toolFinished(generation)
    expect(creates(sent)).toHaveLength(1)
  })

  it('keeps wrap-up tool continuations text-only', () => {
    const { gate: g, sent } = gate()
    g.setDefaults({ output_modalities: ['text'] })
    g.request()
    g.started('wrapup')
    g.toolStarted()
    g.done('wrapup')
    g.toolFinished()
    expect(creates(sent)).toEqual([
      { type: 'response.create', response: { output_modalities: ['text'] } },
      { type: 'response.create', response: { output_modalities: ['text'] } }
    ])
  })
})

describe('tearing down', () => {
  it('drops a held request rather than firing it into a closed channel', () => {
    const { gate: g, sent } = gate()
    g.started()
    g.request({ output_modalities: ['text'] })
    g.discard()
    g.done()

    expect(creates(sent)).toHaveLength(0)
  })

  it('forgets tools that will never report back', () => {
    const { gate: g } = gate()
    g.toolStarted()
    g.toolStarted()
    g.discard()
    expect(g.outstandingTools).toBe(0)
  })
})
