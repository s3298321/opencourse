import type { CoachToolOutcome } from '../types'

type Event = Record<string, any>
interface ResponseState {
  id: string
  delegationId: string
  ended: boolean
  failed: boolean
  continued: boolean
  continuing: boolean
  calls: Map<string, { name: string; args: string; settled: boolean }>
}

/** Backend responses and voice playback are independent state machines. */
export class LiveDelegation {
  private responses = new Map<string, ResponseState>()
  private current = new Map<string, string>()
  private calls = new Set<string>()
  private pending = new Set<Promise<void>>()
  private disposed = false
  private queued: string[] = []
  completions = 0
  writes = 0
  usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  constructor(private readonly hooks: {
    send: (event: Event) => string | void
    tool: (callId: string, name: string, args: string) => Promise<CoachToolOutcome>
    note: (text: string, ok: boolean) => void
    changed: () => void
    beforeContinue?: () => Promise<boolean>
    diagnostic?: (id: string, status: string) => void
    failed?: () => void
  }) {}

  get busy(): boolean { return this.queued.length > 0 || this.pending.size > 0 || [...this.responses.values()].some(r => !r.ended && !r.failed) }
  get pendingTools(): number { return this.pending.size }

  handle(envelope: Event): void {
    const event = envelope.event as Event | undefined
    if (!event || typeof event.type !== 'string') return
    // Closing stops new work, but final backend usage can still arrive before session.closed.
    if (this.disposed && !['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) return
    const delegationId = typeof envelope.delegation_id === 'string' ? envelope.delegation_id : ''
    const response = event.response as Event | undefined
    const id = response?.id ?? event.response_id ?? this.current.get(delegationId)
    if (event.type === 'response.created' && typeof id === 'string') {
      if (this.responses.has(id)) return
      this.queued.shift()
      this.current.set(delegationId, id)
      this.responses.set(id, { id, delegationId, ended: false, failed: false, continued: false, continuing: false, calls: new Map() })
    }
    const state = typeof id === 'string' ? this.responses.get(id) : undefined
    if (!state) return
    if (event.type === 'error') {
      if (!state.ended && !state.failed) {
        state.failed = true
        state.continued = true
        this.hooks.failed?.()
        this.hooks.changed()
      }
      return
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (state.failed) return
      const item = event.item
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        this.hooks.note('The coach returned an incomplete tool call.', false)
        return
      }
      if (this.calls.has(item.call_id)) return
      this.calls.add(item.call_id)
      const call = { name: item.name, args: item.arguments, settled: false }
      state.calls.set(item.call_id, call)
      const work = Promise.resolve().then(() => this.hooks.tool(item.call_id, call.name, call.args)).catch(() => ({
        ok: false, output: JSON.stringify({ ok: false, error: 'The tool could not complete.' }), summary: `Could not run ${call.name}`
      })).then(result => {
        if (this.disposed) return
        if (result.ok && ['write_file', 'append_file'].includes(call.name)) this.writes++
        this.hooks.note(result.summary, result.ok)
        this.hooks.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: result.output } })
        call.settled = true
      }).finally(() => {
        this.pending.delete(work)
        this.continue(state)
        this.hooks.changed()
      })
      this.pending.add(work)
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      if (state.ended) return
      state.ended = true
      this.completions++
      const status = String(response?.status ?? event.type.slice(9))
      const usage = response?.usage
      if (usage) {
        this.usage.inputTokens += finite(usage.input_tokens)
        this.usage.outputTokens += finite(usage.output_tokens)
        this.usage.totalTokens += finite(usage.total_tokens)
      }
      this.hooks.diagnostic?.(state.id, status)
      if (status !== 'completed') {
        state.continued = true
        this.hooks.note('The coach’s background work did not finish. Please try your request again.', false)
        if (!state.failed && !this.disposed) this.hooks.failed?.()
        state.failed = true
      }
      this.continue(state)
    }
    this.hooks.changed()
  }

  private continue(state: ResponseState): void {
    if (this.disposed || !state.ended || state.continued || !state.calls.size || [...state.calls.values()].some(c => !c.settled)) return
    state.continued = true
    state.continuing = true
    const continuing = Promise.resolve(this.hooks.beforeContinue?.() ?? true).then(allowed => {
      if (allowed && !state.failed) this.request()
    }).finally(() => { state.continuing = false; this.pending.delete(continuing); this.hooks.changed() })
    this.pending.add(continuing)
  }

  request(): void {
    if (this.disposed) return
    const id = this.hooks.send({ type: 'response.create' })
    this.queued.push(id ?? '')
  }

  reject(clientEventId?: string): boolean {
    if (this.disposed) return false
    if (clientEventId) {
      const index = this.queued.indexOf(clientEventId)
      // An unrelated command error must not cancel healthy backend work.
      if (index < 0) return false
      this.queued.splice(index, 1)
    } else {
      // Automatic delegations can fail with only a session error: no client ID
      // and no terminal response event. Release their stale busy state without
      // replaying tools. Keep the response for any late usage/completion event.
      const active = [...this.responses.values()].filter(r => (!r.ended || r.continuing) && !r.failed)
      if (!active.length && !this.queued.length) return false
      this.queued = []
      for (const state of active) { state.failed = true; state.continued = true }
    }
    this.hooks.failed?.()
    this.hooks.changed()
    return true
  }

  dispose(): void { this.disposed = true }
}
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
