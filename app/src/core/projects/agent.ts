/** Pure bounded Responses tool loop, independently testable without Electron or a key. */
export type ResponseInput = { role: string; content: string } | ({ type: string } & Record<string, unknown>)
export interface ProjectRound { text: string; aborted: boolean; output?: Record<string, unknown>[] }
export interface ProjectAgentOptions {
  input: ResponseInput[]
  signal: AbortSignal
  stream: (input: ResponseInput[]) => Promise<ProjectRound>
  tool: (name: string, args: unknown, callId: string) => Promise<string>
  limits?: { rounds: number; calls: number }
}
export async function runProjectAgent(options: ProjectAgentOptions): Promise<{ stopped: boolean }> {
  const input = [...options.input]
  // Keep explicit instructions on every request, even after the server compacts
  // the conversation. The encrypted compaction item replaces prior history.
  const instructions = options.input.filter(item => 'role' in item && (item.role === 'system' || item.role === 'developer'))
  const seen = new Map<string, string>()
  let calls = 0
  const limits = options.limits ?? { rounds: 8, calls: 32 }
  for (let round = 0; round < limits.rounds; round++) {
    if (options.signal.aborted) return { stopped: true }
    const result = await options.stream(input)
    if (result.aborted || options.signal.aborted) return { stopped: true }
    const output = result.output ?? []
    const requested = output.filter((item) => item.type === 'function_call')
    if (!requested.length) return { stopped: false }
    // Continuation needs all response output, including opaque reasoning items.
    for (const item of output) {
      if (typeof item.type !== 'string') throw new Error('OpenAI returned an invalid response item.')
      input.push(item as ResponseInput)
    }
    for (const item of requested) {
      if (++calls > limits.calls) throw new Error('The assistant reached its tool-call limit. Completed work is preserved; send another message to continue.')
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('OpenAI returned an incomplete file-tool call.')
      if (options.signal.aborted) return { stopped: true }
      let outputText = seen.get(item.call_id)
      if (outputText === undefined) {
        let args: unknown
        try { args = JSON.parse(item.arguments) } catch { args = null }
        outputText = args === null ? JSON.stringify({ ok: false, error: 'Malformed tool arguments.' }) : await options.tool(item.name, args, item.call_id)
        seen.set(item.call_id, outputText)
      }
      input.push({ type: 'function_call_output', call_id: item.call_id, output: outputText })
    }
    // Only prune after all tools have returned, so the next request contains
    // their results. Never trim the opaque compaction item or anything after it.
    let compactedAt = -1
    for (let n = input.length - 1; n >= 0; n--) {
      const item = input[n]
      if ('type' in item && item.type === 'compaction') { compactedAt = n; break }
    }
    if (compactedAt >= 0) input.splice(0, compactedAt, ...instructions)
  }
  throw new Error('The assistant reached its reasoning-round limit. Completed work is preserved; send another message to continue.')
}
