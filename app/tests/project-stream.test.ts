// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResponseInput } from '../src/core/projects/agent'
import { runProjectAgent } from '../src/core/projects/agent'
const mocked = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocked.fetch } }))
const { streamChat } = await import('../src/main/openai')
const { PROJECT_TOOLS } = await import('../src/core/projects/tools')
const encoder = new TextEncoder()
function response(events: unknown[], crlf = false) {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  const text = crlf ? data.replaceAll('\n', '\r\n') : data
  return { ok: true, body: new ReadableStream<Uint8Array>({ start(controller) {
    for (let n = 0; n < text.length; n += 17) controller.enqueue(encoder.encode(text.slice(n, n + 17)))
    controller.close()
  } }) }
}
beforeEach(() => mocked.fetch.mockReset())
describe('a stream OpenAI stops partway', () => {
  it('says why, from response.error, and logs the failure without the answer\'s text', async () => {
    const { log } = await import('../src/main/log')
    const records: { message: string; data?: Record<string, unknown> }[] = []
    log.addSink({ name: 'test', minLevel: 'debug', write: (r) => records.push(r) })
    mocked.fetch.mockResolvedValue(response([
      { type: 'response.output_text.delta', delta: 'Half an answer' },
      { type: 'response.failed', response: { id: 'resp_1', status: 'failed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Half an answer' }] }], instructions: 'secret prompt',
        error: { code: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 600 } } }
    ]))
    await expect(streamChat({ key: 'key', provider: 'chatgpt', model: 'gpt-5.3-codex', input: [], onDelta: () => {} }))
      .rejects.toThrow('ChatGPT plan usage limit reached. Manage usage in ChatGPT Settings, or try again later. It resets in about 10 min.')
    log.removeSink('test')
    const failure = records.find((r) => r.message === 'OpenAI stopped an answer')
    expect(failure?.data).toMatchObject({ type: 'response.failed', code: 'usage_limit_reached', provider: 'chatgpt', model: 'gpt-5.3-codex' })
    expect(String(failure?.data?.['event'])).toContain('usage_limit_reached')
    expect(JSON.stringify(records)).not.toMatch(/Half an answer|secret prompt/)
  })
})
describe('Responses streaming with project tools', () => {
  it('collects only completed arguments and preserves reasoning and final output across split CRLF frames', async () => {
    const reasoning = { type: 'reasoning', encrypted_content: 'opaque', summary: [] }
    const call = { type: 'function_call', call_id: 'one', name: 'read_project_file', arguments: '{"path":"README.md","start_line":1,"max_lines":100}' }
    mocked.fetch.mockResolvedValue(response([
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path"' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: ':"README.md"}' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { output: [reasoning, call] } }
    ], true))
    const onDelta = vi.fn()
    const result = await streamChat({ key: 'key', model: 'gpt-5-mini', input: [], tools: PROJECT_TOOLS, onDelta })
    expect(result.output).toEqual([reasoning, call]); expect(onDelta).not.toHaveBeenCalled()
    expect(JSON.parse(mocked.fetch.mock.calls[0][1].body)).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], tools: PROJECT_TOOLS })
  })
  it('refuses to treat a disconnected stream with partial arguments as a completed answer', async () => {
    mocked.fetch.mockResolvedValue(response([{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' }]))
    await expect(streamChat({ key: 'key', model: 'gpt-5-mini', input: [], tools: PROJECT_TOOLS, onDelta: () => {} })).rejects.toThrow('before completing')
  })
  it('adapts subscription project tools and preserves encrypted reasoning through continuation', async () => {
    const reasoning = { type: 'reasoning', encrypted_content: 'opaque', summary: [] }
    const call = { type: 'function_call', namespace: 'project', call_id: 'one', name: 'read_project_file', arguments: '{"path":"README.md"}' }
    mocked.fetch.mockResolvedValueOnce(response([{ type: 'response.completed', response: { output: [reasoning, call] } }]))
    const first = await streamChat({ provider: 'chatgpt', key: 'subscription', model: 'gpt-5.3-codex', input: [{ role: 'system', content: 'Review carefully' }], tools: PROJECT_TOOLS, onDelta: () => {} })
    const request = JSON.parse(mocked.fetch.mock.calls[0][1].body)
    expect(request).toMatchObject({ store: false, stream: true, input: [{ role: 'developer', content: 'Review carefully' }], tools: [{ type: 'namespace', name: 'project', tools: PROJECT_TOOLS }] })
    expect(request).not.toHaveProperty('max_output_tokens')
    mocked.fetch.mockResolvedValueOnce(response([{ type: 'response.output_text.delta', delta: 'Review' }, { type: 'response.completed', response: { output: [] } }]))
    const continuation = [...first.output!, { type: 'function_call_output', call_id: 'one', output: 'file contents' }] as ResponseInput[]
    await streamChat({ provider: 'chatgpt', key: 'subscription', model: 'gpt-5.3-codex', input: continuation, tools: PROJECT_TOOLS, onDelta: () => {} })
    expect(JSON.parse(mocked.fetch.mock.calls[1][1].body).input).toEqual(continuation)
  })
  it('reports subscription limits without retrying or switching billing', async () => {
    mocked.fetch.mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":{"message":"limit"}}' })
    await expect(streamChat({ provider: 'chatgpt', key: 'subscription', model: 'gpt-5.3-codex', input: [], onDelta: () => {} })).rejects.toThrow('Manage usage')
    expect(mocked.fetch).toHaveBeenCalledTimes(1)
    expect(mocked.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer subscription')
  })
  it.each(['apiKey', 'chatgpt'] as const)('continues a large tool run through streamed compaction using %s', async provider => {
    const instruction = { role: 'system', content: 'Review carefully' }
    const firstCall = { type: 'function_call', call_id: 'one', name: 'read_project_file', arguments: '{"path":"README.md"}' }
    const nextCall = { ...firstCall, call_id: 'two' }
    const compacted = { type: 'compaction', id: 'cmp_one', encrypted_content: 'opaque state' }
    mocked.fetch.mockResolvedValueOnce(response([{ type: 'response.completed', response: { output: [firstCall] } }]))
      .mockResolvedValueOnce(response([
        { type: 'response.output_item.done', output_index: 0, item: compacted },
        { type: 'response.output_item.done', output_index: 1, item: nextCall },
        { type: 'response.completed', response: { output: [compacted, nextCall] } }
      ], true))
      .mockResolvedValueOnce(response([{ type: 'response.output_text.delta', delta: 'Done' }, { type: 'response.completed', response: { output: [] } }]))
    const tool = vi.fn().mockResolvedValueOnce('large file\n'.repeat(30_000)).mockResolvedValueOnce('small file')
    await expect(runProjectAgent({ input: [instruction, { role: 'user', content: 'Review my work' }], signal: new AbortController().signal, tool,
      stream: input => streamChat({ provider, key: 'test-credential', model: 'gpt-6.1-sol', input, tools: PROJECT_TOOLS, onDelta: () => {} })
    })).resolves.toEqual({ stopped: false })
    const bodies = mocked.fetch.mock.calls.map(([, options]) => JSON.parse(options.body))
    expect(JSON.stringify(bodies[1].input).length).toBeGreaterThan(240_000)
    expect(bodies[2].input).toEqual([{ ...instruction, role: provider === 'chatgpt' ? 'developer' : 'system' }, compacted, nextCall,
      { type: 'function_call_output', call_id: 'two', output: 'small file' }])
    for (const body of bodies) expect(body.context_management).toEqual([{ type: 'compaction', compact_threshold: 244_800 }])
    expect(mocked.fetch.mock.calls.every(([, options]) => options.headers.Authorization === 'Bearer test-credential')).toBe(true)
    expect(tool).toHaveBeenCalledTimes(2)
  })
  it('forwards a lower catalog threshold in the actual streaming request', async () => {
    mocked.fetch.mockResolvedValue(response([{ type: 'response.completed', response: { output: [] } }]))
    await streamChat({ provider: 'chatgpt', key: 'subscription', model: 'gpt-new', modelContext: { contextWindow: 128_000, autoCompactTokenLimit: 100_000 },
      input: [], tools: PROJECT_TOOLS, onDelta: () => {} })
    expect(JSON.parse(mocked.fetch.mock.calls[0][1].body).context_management).toEqual([{ type: 'compaction', compact_threshold: 100_000 }])
  })
})
