/** Shared, bounded text-agent execution. Product permissions remain in tool handlers. */
export type ResponseInput = { role: string; content: string } | ({ type: string } & Record<string, unknown>)
export interface ResponseUsage { input: number; cachedInput: number | null; output: number; reasoning: number | null; total: number }
export interface ProjectRound { text: string; aborted: boolean; output?: Record<string, unknown>[]; usage?: ResponseUsage; responseId?: string }
export interface ProjectAgentOptions {
  input: ResponseInput[]
  signal: AbortSignal
  stream: (input: ResponseInput[]) => Promise<ProjectRound>
  tool: (name: string, args: unknown, callId: string) => Promise<string>
  limits?: { rounds: number; calls: number }
  readOnly?: (name: string) => boolean
  /** Only provide a key when the handler can establish source freshness. */
  cacheKey?: (name: string, args: unknown) => string | undefined
  checkpoint?: (input: ResponseInput[]) => void
}

export function compactInput(input: ResponseInput[], instructions: ResponseInput[]): ResponseInput[] {
  let index = -1
  for (let n = input.length - 1; n >= 0; n--) { const item = input[n]!; if ('type' in item && item.type === 'compaction') { index = n; break } }
  if (index < 0) return input
  const tail = input.slice(index)
  // Compaction can precede a tool result whose call was earlier in this response.
  // Retain complete call/result groups, including calls before the checkpoint.
  const calls = new Set(tail.filter(i => 'type' in i && i.type === 'function_call').map(i => 'call_id' in i ? i.call_id : undefined))
  const missing = new Set(tail.filter(i => 'type' in i && i.type === 'function_call_output' && !calls.has(i.call_id)).map(i => 'call_id' in i ? i.call_id : undefined))
  const required = input.slice(0, index).filter(i => 'type' in i && i.type === 'function_call' && missing.has(i.call_id))
  return [...instructions, ...tail.slice(0, 1), ...required, ...tail.slice(1)]
}

export async function runTextAgent(options: ProjectAgentOptions): Promise<{ stopped: boolean }> {
  let input = [...options.input]
  const instructions = options.input.filter(item => 'role' in item && (item.role === 'system' || item.role === 'developer'))
  const seen = new Map<string, { signature: string; result: Promise<string> }>()
  for (const item of input) {
    if (!('type' in item) || item.type !== 'function_call_output' || typeof item.output !== 'string') continue
    const call = input.find(i => 'type' in i && i.type === 'function_call' && i.call_id === item.call_id)
    if (call && 'name' in call) seen.set(String(item.call_id), { signature: JSON.stringify([call.name, call.arguments]), result: Promise.resolve(item.output) })
  }
  const cached = new Map<string, Promise<string>>()
  let calls = 0
  const limits = options.limits ?? { rounds: 8, calls: 32 }
  for (let round = 0; round < limits.rounds; round++) {
    if (options.signal.aborted) return { stopped: true }
    const result = await options.stream(input)
    if (result.aborted || options.signal.aborted) return { stopped: true }
    const output = result.output ?? []
    const requested = output.filter(item => item.type === 'function_call')
    for (const item of output) {
      if (typeof item.type !== 'string') throw new Error('OpenAI returned an invalid response item.')
    }
    const callIds = new Set((output.some(i => i.type === 'compaction') ? [] : input).flatMap(i => 'type' in i && i.type === 'function_call' ? [i.call_id] : []))
    const uniqueOutput = output.filter(item => {
      if (item.type !== 'function_call') return true
      if (callIds.has(item.call_id)) return false
      callIds.add(item.call_id); return true
    })
    const next = [...input, ...uniqueOutput as ResponseInput[]]
    if (!requested.length) {
      // Mock transports and older responses may supply only text.
      if (!output.some(i => i.type === 'message') && result.text) next.push({ role: 'assistant', content: result.text })
      input = compactInput(next, instructions)
      options.checkpoint?.(input)
      return { stopped: false }
    }
    const execute = async (item: Record<string, unknown>): Promise<ResponseInput> => {
      if (++calls > limits.calls) throw new Error('The assistant reached its tool-call limit. Completed work is preserved; send another message to continue.')
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('OpenAI returned an incomplete tool call.')
      if (options.signal.aborted) throw new Error('Assistant stopped.')
      const signature = JSON.stringify([item.name, item.arguments])
      const prior = seen.get(item.call_id)
      if (prior && prior.signature !== signature) throw new Error('OpenAI reused a tool-call ID with conflicting arguments.')
      let pending = prior?.result
      if (!pending) {
        let args: unknown
        try { args = JSON.parse(item.arguments) } catch { args = null }
        const readOnly = options.readOnly?.(item.name) === true
        const cacheKey = args !== null && readOnly ? options.cacheKey?.(item.name, args) : undefined
        if (!readOnly) cached.clear()
        pending = cacheKey ? cached.get(cacheKey) : undefined
        if (!pending) {
          pending = args === null ? Promise.resolve(JSON.stringify({ ok: false, error: 'Malformed tool arguments.' })) : options.tool(item.name, args, item.call_id)
          if (cacheKey) {
            cached.set(cacheKey, pending)
            // Failed retrievals must remain retryable.
            void pending.then(value => { try { const o = JSON.parse(value); if (o.error || o.ok === false) cached.delete(cacheKey) } catch { /* text result */ } }, () => cached.delete(cacheKey))
          }
        }
        seen.set(item.call_id, { signature, result: pending })
      }
      return { type: 'function_call_output', call_id: item.call_id, output: await pending }
    }
    const results: ResponseInput[] = []
    if (requested.every(item => typeof item.name === 'string' && options.readOnly?.(item.name))) {
      for (let start = 0; start < requested.length; start += 3) {
        const batch = await Promise.allSettled(requested.slice(start, start + 3).map(execute))
        const failed = batch.find(r => r.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        results.push(...batch.map(r => (r as PromiseFulfilledResult<ResponseInput>).value))
        if (options.signal.aborted) return { stopped: true }
      }
    } else {
      for (const item of requested) {
        results.push(await execute(item))
        if (options.signal.aborted) return { stopped: true }
      }
    }
    const compacted = compactInput(next, instructions)
    const resultIds = new Set(compacted.flatMap(i => 'type' in i && i.type === 'function_call_output' ? [i.call_id] : []))
    input = compactInput([...compacted, ...results.filter(i => {
      if (!('call_id' in i) || resultIds.has(i.call_id)) return false
      resultIds.add(i.call_id); return true
    })], instructions)
    options.checkpoint?.(input)
  }
  throw new Error('The assistant reached its reasoning-round limit. Completed work is preserved; send another message to continue.')
}
