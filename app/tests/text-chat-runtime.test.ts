// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { compactInput, runTextAgent, type ResponseInput } from '../src/core/text-chat/agent'
import { responseUsage } from '../src/core/text-chat/usage'
import { notebookContextText } from '../src/core/notebook/context'
import { readNotebookCells } from '../src/core/notebook/reading'
import { projectCourse } from './helpers/project'
const call = (id: string, name = 'read', args = '{}') => ({ type: 'function_call', call_id: id, name, arguments: args })
const signal = () => new AbortController().signal

describe('text runtime reliability and accounting', () => {
  it('preserves a compaction returned with the final answer', async () => {
    const checkpoint = vi.fn(), compact = { type: 'compaction', encrypted_content: 'opaque' }
    await runTextAgent({ input: [{ role: 'system', content: 'Teach' }, { role: 'user', content: 'Old history' }], signal: signal(),
      stream: async () => ({ text: 'Answer', aborted: false, output: [compact] }), tool: vi.fn(), checkpoint })
    expect(checkpoint.mock.calls[0][0]).toEqual([{ role: 'system', content: 'Teach' }, compact, { role: 'assistant', content: 'Answer' }])
  })
  it('preserves matched calls when compaction appears after their invocation', () => {
    const instruction = { role: 'system', content: 'Teach' }
    const compact = { type: 'compaction', encrypted_content: 'opaque' }
    const result = { type: 'function_call_output', call_id: 'one', output: 'text' }
    expect(compactInput([instruction, call('one'), compact, result], [instruction])).toEqual([instruction, compact, call('one'), result])
  })
  it('limits independent read concurrency to three and preserves model output order', async () => {
    let active = 0, maximum = 0, round = 0
    const inputs: ResponseInput[][] = []
    await runTextAgent({ input: [], signal: signal(), readOnly: () => true,
      stream: async input => { inputs.push(structuredClone(input)); return { text: '', aborted: false, output: round++ ? [] : Array.from({ length: 7 }, (_, n) => call(String(n))) } },
      tool: async (_name, _args, id) => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 7 - Number(id))); active--; return id } })
    expect(maximum).toBe(3)
    expect(inputs[1].filter(i => 'type' in i && i.type === 'function_call_output').map(i => 'output' in i ? i.output : '')).toEqual(['0','1','2','3','4','5','6'])
  })
  it('serializes mixed batches and invalidates read memoization after writes', async () => {
    let round = 0, version = 0
    const events: string[] = []
    const batches = [[call('a')], [call('b')], [call('c', 'write'), call('d')]]
    await runTextAgent({ input: [], signal: signal(), readOnly: name => name === 'read', cacheKey: () => String(version),
      stream: async () => ({ text: '', aborted: false, output: batches[round++] ?? [] }),
      tool: async name => { events.push(name); if (name === 'write') version++; return String(version) } })
    expect(events).toEqual(['read','write','read'])
  })
  it('rejects conflicting repeated IDs before a second mutation executes', async () => {
    const tool = vi.fn(async () => 'ok')
    let round = 0
    await expect(runTextAgent({ input: [], signal: signal(), tool,
      stream: async () => ({ text: '', aborted: false, output: [call('same', 'write', JSON.stringify({ n: round++ }))] }) })).rejects.toThrow('conflicting arguments')
    expect(tool).toHaveBeenCalledOnce()
  })
  it('does not save an unmatched tool group after a failure', async () => {
    const checkpoint = vi.fn()
    await expect(runTextAgent({ input: [], signal: signal(), checkpoint,
      stream: async () => ({ text: '', aborted: false, output: [call('one', 'write'), call('two', 'write')] }),
      tool: async (_name, _args, id) => { if (id === 'two') throw new Error('interrupted'); return 'saved' } })).rejects.toThrow('interrupted')
    expect(checkpoint).not.toHaveBeenCalled()
  })
  it('stops scheduling further reads after cancellation', async () => {
    const controller = new AbortController(), tool = vi.fn(async () => { controller.abort(); return 'read' })
    await expect(runTextAgent({ input: [], signal: controller.signal, readOnly: () => true, tool,
      stream: async () => ({ text: '', aborted: false, output: Array.from({ length: 6 }, (_, n) => call(String(n))) }) })).rejects.toThrow('stopped')
    expect(tool).toHaveBeenCalledOnce()
  })
  it('distinguishes missing usage from zero and keeps reasoning inside output totals', () => {
    expect(responseUsage(undefined)).toBeUndefined()
    expect(responseUsage({ input_tokens: -1, output_tokens: 0, total_tokens: 0 })).toBeUndefined()
    expect(responseUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 130 }))
      .toEqual({ input: 100, cachedInput: 80, output: 30, reasoning: 20, total: 130 })
    expect(responseUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toEqual({ input: 0, output: 0, total: 0, cachedInput: null, reasoning: null })
  })
  it('prioritizes a late quoted notebook cell and retrieves omitted content', () => {
    const notebook = { version: 1 as const, revision: 4, cells: [{ id: 'first', content: 'a'.repeat(30000) }, { id: 'selected', content: 'target = 42' }] }
    const context = notebookContextText(projectCourse(), notebook, 3000, 'selected')
    expect(context).toContain('Cell 2:')
    expect(context).toContain('target = 42')
    const result = JSON.parse(readNotebookCells(notebook, { cursor: 0, offset: 0 }, { chars: 0, signal: signal() }))
    expect(result.cellId).toBe('first'); expect(result.nextOffset).toBe(6000)
  })
})
