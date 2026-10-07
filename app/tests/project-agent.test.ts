import { describe, expect, it, vi } from 'vitest'
import { runProjectAgent } from '../src/core/projects/agent'
const call = (id = 'one', name = 'read_project_file', args = '{"path":"README.md","start_line":1,"max_lines":100}') => ({ type: 'function_call', name, call_id: id, arguments: args })
describe('bounded project agent continuation', () => {
  it('returns all output items, including reasoning, alongside matched tool outputs', async () => {
    const reasoning = { type: 'reasoning', encrypted_content: 'opaque', summary: [] }
    const stream = vi.fn().mockResolvedValueOnce({ text: '', aborted: false, output: [reasoning, call()] }).mockResolvedValueOnce({ text: 'Feedback', aborted: false, output: [{ type: 'message', role: 'assistant', content: [] }] })
    const tool = vi.fn().mockResolvedValue('{"ok":true,"text":"1: Work"}')
    await expect(runProjectAgent({ input: [{ role: 'user', content: 'Review this.' }], signal: new AbortController().signal, stream, tool })).resolves.toEqual({ stopped: false })
    expect(tool).toHaveBeenCalledWith('read_project_file', { path: 'README.md', start_line: 1, max_lines: 100 }, 'one')
    expect(stream.mock.calls[1][0]).toEqual(expect.arrayContaining([reasoning, call(), { type: 'function_call_output', call_id: 'one', output: '{"ok":true,"text":"1: Work"}' }]))
  })
  it('handles several calls and malformed JSON without losing their call IDs', async () => {
    const stream = vi.fn().mockResolvedValueOnce({ text: '', aborted: false, output: [call('one'), call('two', 'list_project_files', 'bad')] }).mockResolvedValueOnce({ text: 'done', aborted: false, output: [] })
    const tool = vi.fn().mockResolvedValue('ok')
    await runProjectAgent({ input: [], signal: new AbortController().signal, stream, tool })
    expect(tool).toHaveBeenCalledTimes(1)
    expect(stream.mock.calls[1][0]).toContainEqual({ type: 'function_call_output', call_id: 'two', output: '{"ok":false,"error":"Malformed tool arguments."}' })
  })
  it('does not execute a repeated call twice', async () => {
    const stream = vi.fn().mockResolvedValueOnce({ text: '', aborted: false, output: [call(), call()] }).mockResolvedValueOnce({ text: 'done', aborted: false, output: [] })
    const tool = vi.fn().mockResolvedValue('ok')
    await runProjectAgent({ input: [], signal: new AbortController().signal, stream, tool })
    expect(tool).toHaveBeenCalledTimes(1)
  })
  it('continues past the former character limit without discarding tool results', async () => {
    const large = 'file contents '.repeat(25_000)
    const inputs: unknown[] = []
    const stream = vi.fn(async input => {
      inputs.push(structuredClone(input))
      return inputs.length === 1 ? { text: '', aborted: false, output: [call()] } : { text: 'Done', aborted: false, output: [] }
    })
    await expect(runProjectAgent({ input: [{ role: 'user', content: 'Review' }], signal: new AbortController().signal,
      stream, tool: async () => large })).resolves.toEqual({ stopped: false })
    expect(JSON.stringify(inputs[1]).length).toBeGreaterThan(240_000)
    expect(inputs[1]).toEqual([{ role: 'user', content: 'Review' }, call(), { type: 'function_call_output', call_id: 'one', output: large }])
  })
  it('keeps the latest opaque compaction, instructions and subsequent results across repeated compactions', async () => {
    const instruction = { role: 'system', content: 'Keep teaching' }
    const first = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-one' }
    const last = { type: 'compaction', id: 'cmp_2', encrypted_content: 'opaque-two' }
    const reasoning = { type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: [] }
    const inputs: unknown[] = []
    const stream = vi.fn(async input => {
      inputs.push(structuredClone(input))
      return { text: '', aborted: false, output: inputs.length === 1 ? [first, reasoning, call()]
        : inputs.length === 2 ? [call('two')]
        : inputs.length === 3 ? [last, call()] : [] }
    })
    const tool = vi.fn().mockResolvedValue('completed edit')
    await expect(runProjectAgent({ input: [instruction, { role: 'user', content: 'Old conversation' }],
      signal: new AbortController().signal, stream, tool })).resolves.toEqual({ stopped: false })
    expect(inputs[1]).toEqual([instruction, first, reasoning, call(), { type: 'function_call_output', call_id: 'one', output: 'completed edit' }])
    expect(inputs[2]).toEqual([...(inputs[1] as unknown[]), call('two'), { type: 'function_call_output', call_id: 'two', output: 'completed edit' }])
    expect(inputs[3]).toEqual([instruction, last, call(), { type: 'function_call_output', call_id: 'one', output: 'completed edit' }])
    expect(tool).toHaveBeenCalledTimes(2)
  })
  it('stops without executing tools after abort and imposes round and call limits', async () => {
    const controller = new AbortController(); controller.abort()
    const stream = vi.fn().mockResolvedValue({ text: '', aborted: false, output: [call()] })
    const tool = vi.fn().mockResolvedValue('ok')
    expect(await runProjectAgent({ input: [], signal: controller.signal, stream, tool })).toEqual({ stopped: true })
    expect(stream).not.toHaveBeenCalled()
    await expect(runProjectAgent({ input: [], signal: new AbortController().signal, stream, tool })).rejects.toThrow('reasoning-round limit')
    const many = vi.fn().mockResolvedValue({ text: '', aborted: false, output: Array.from({ length: 33 }, (_, n) => call(String(n))) })
    await expect(runProjectAgent({ input: [], signal: new AbortController().signal, stream: many, tool })).rejects.toThrow('tool-call limit')
  })
})
