/**
 * What a learner reads when OpenAI stops an answer. The first version read only
 * `event.error`, so a ChatGPT plan out of its five-hour allowance - reported as
 * `response.failed` with the reason under `response.error` - surfaced as
 * "OpenAI stopped the answer (response.failed)".
 */
import { describe, expect, it } from 'vitest'
import { CHATGPT_USAGE_LIMIT, describeStreamFailure, resetHint } from '../src/core/ai-errors'

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)

describe('describeStreamFailure', () => {
  it('ignores events that are not failures', () => {
    expect(describeStreamFailure({ type: 'response.output_text.delta', delta: 'hi' })).toBeNull()
    expect(describeStreamFailure({ type: 'response.completed', response: {} })).toBeNull()
    expect(describeStreamFailure({})).toBeNull()
  })

  it('reads a usage limit nested under response.error, with when it lifts', () => {
    const event = {
      type: 'response.failed',
      response: { id: 'resp_1', status: 'failed', error: { code: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 2 * 3600 + 14 * 60 } }
    }
    const failure = describeStreamFailure(event, 'chatgpt', NOW)
    expect(failure).toEqual({ type: 'response.failed', code: 'usage_limit_reached', message: `${CHATGPT_USAGE_LIMIT} It resets in about 2 h 14 min.` })
  })

  it('recognises a plan limit by its message when the code is a rate limit', () => {
    const event = { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: "You've hit your usage limit. Try again later." } } }
    expect(describeStreamFailure(event, 'chatgpt', NOW)?.message).toBe(CHATGPT_USAGE_LIMIT)
  })

  it('takes an absolute reset time as well as a relative one', () => {
    expect(resetHint({ resets_at: NOW / 1000 + 6 * 60 }, NOW)).toBe(' It resets in about 6 min.')
    expect(resetHint({ resets_at: NOW / 1000 - 60 }, NOW)).toBe('')
    expect(resetHint({}, NOW)).toBe('')
    expect(resetHint(null, NOW)).toBe('')
  })

  it('tells an API key that is out of credit what to do', () => {
    const event = { type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } }
    expect(describeStreamFailure(event, 'apiKey', NOW)?.message).toMatch(/out of credit/)
  })

  it('keeps OpenAI\'s own wording for a transient rate limit, which says how long to wait', () => {
    const event = { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } } }
    expect(describeStreamFailure(event, 'apiKey', NOW)?.message).toBe('Rate limit reached. Please try again in 1.5s. (rate_limit_exceeded)')
  })

  it('explains an incomplete answer by its reason', () => {
    const event = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
    expect(describeStreamFailure(event, 'apiKey', NOW)).toEqual({ type: 'response.incomplete', code: 'max_output_tokens', message: expect.stringMatching(/output limit/) })
  })

  it('reads a top-level error event, nested or flat', () => {
    expect(describeStreamFailure({ type: 'error', error: { code: 'server_error', message: 'boom' } }, 'apiKey', NOW)?.message).toMatch(/server error/)
    expect(describeStreamFailure({ type: 'error', code: 'odd_code', message: 'Something odd' }, 'apiKey', NOW)?.message).toBe('Something odd (odd_code)')
  })

  it('uses OpenAI\'s message for a code it does not know', () => {
    const event = { type: 'response.failed', response: { error: { code: 'new_thing', message: 'A new kind of failure' } } }
    expect(describeStreamFailure(event, 'chatgpt', NOW)).toEqual({ type: 'response.failed', code: 'new_thing', message: 'A new kind of failure (new_thing)' })
  })

  it('still says something when the event carries nothing readable', () => {
    expect(describeStreamFailure({ type: 'response.failed' })?.message).toBe('OpenAI stopped the answer (response.failed)')
    expect(describeStreamFailure({ type: 'response.failed', response: 'not an object' })?.message).toBe('OpenAI stopped the answer (response.failed)')
    expect(describeStreamFailure({ type: 'response.failed', response: { error: { code: 42, message: null } } })?.message).toBe('OpenAI stopped the answer (response.failed)')
  })
})
