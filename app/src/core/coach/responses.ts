/**
 * Who gets to ask the coach to speak next.
 *
 * The Realtime API allows exactly one active response at a time. Asking for
 * another while one is running is refused outright:
 *
 *   Conversation already has an active response in progress: resp_… .
 *   Wait until the response is finished before creating a new one.
 *
 * The obvious implementation - send `response.create` when a tool call
 * finishes - produces exactly that error whenever the coach does more than one
 * thing in a turn, which for a coach keeping three memory files is most turns.
 * The rule is: submit every tool's output as it lands, but ask for a reply
 * **once**, after the last tool of the batch, and only when the conversation is
 * quiet.
 *
 * Pure, with `send` injected, so the rule is a unit test rather than something
 * you find out by reading a live session's error log.
 */

export type SendEvent = (payload: Record<string, unknown>) => void

export class ResponseGate {
  private readonly send: SendEvent
  private active = false
  private queued: Record<string, unknown> | null = null
  private pendingTools = 0
  private generation = 0
  private activeGeneration = 0
  private wantsToolReply = false
  private learnerSpeaking = false
  private cancelling = false
  private responseId = ''
  private readonly completedIds = new Set<string>()
  private defaults: Record<string, unknown> = {}

  constructor(send: SendEvent) {
    this.send = send
  }

  /** True while OpenAI is producing a response and will refuse another. */
  get busy(): boolean {
    return this.active
  }

  get isCancelling(): boolean {
    return this.cancelling
  }

  get outstandingTools(): number {
    return this.pendingTools
  }

  toolStarted(): number {
    this.pendingTools += 1
    return this.activeGeneration
  }

  /**
   * Returns true when this was the last tool of the batch and a reply was
   * asked for - which is the moment the conversation resumes.
   */
  toolFinished(generation = this.generation): boolean {
    if (this.pendingTools === 0) return false
    this.pendingTools -= 1
    if (generation === this.generation) this.wantsToolReply = true
    if (this.pendingTools > 0) return false
    // An interrupted turn's writes can finish, but must not start another
    // answer to the old statement. A newer held request still gets released.
    if (this.queued) this.request(this.queued)
    else if (this.wantsToolReply) this.request()
    else return false
    this.wantsToolReply = false
    return true
  }

  setDefaults(response: Record<string, unknown>): void {
    this.defaults = response
  }

  /** Automatic VAD already cancels the server response; don't cancel twice. */
  speechStarted(): void {
    this.generation += 1
    this.queued = null
    this.wantsToolReply = false
    this.learnerSpeaking = true
    if (this.active) this.cancelling = true
  }

  speechStopped(): void {
    this.learnerSpeaking = false
    // The server will start the learner's reply. Never resume an old turn here.
  }

  /** Confirmed learner speech supersedes both the reply and its continuation. */
  interrupt(): void {
    this.generation += 1
    this.queued = null
    this.wantsToolReply = false
    if (!this.active || this.cancelling) return
    this.cancelling = true
    this.send({ type: 'response.cancel', ...(this.responseId ? { response_id: this.responseId } : {}) })
    // Wait for response.done before releasing the learner's next reply.
  }

  /** Asks for a reply, or holds the request until the current one is done. */
  request(response: Record<string, unknown> = this.defaults): void {
    if (this.active || this.pendingTools > 0 || this.learnerSpeaking) {
      this.queued = response
      return
    }
    this.queued = null
    this.active = true
    this.activeGeneration = this.generation
    this.responseId = ''
    this.send({ type: 'response.create', ...(Object.keys(response).length ? { response } : {}) })
  }

  /** A `response.created` arrived - including one we did not ask for. */
  started(responseId = ''): void {
    if (!this.active) {
      this.activeGeneration = this.generation
      // An automatic reply fulfils any held request. Keeping it would create
      // another answer as soon as this one finishes.
      this.queued = null
      this.wantsToolReply = false
    }
    this.active = true
    this.responseId = responseId
  }

  /** A `response.done` arrived. Releases anything that was held back. */
  done(responseId = ''): void {
    if (responseId && this.completedIds.has(responseId)) return
    if (responseId && this.responseId && this.responseId !== responseId) return
    if (responseId) {
      this.completedIds.add(responseId)
      if (this.completedIds.size > 100) this.completedIds.delete(this.completedIds.values().next().value as string)
    }
    this.active = false
    this.cancelling = false
    this.responseId = ''
    const queued = this.queued
    // A tool still running will ask for the reply itself when it lands; asking
    // now would only get in its way.
    if (queued && this.pendingTools === 0 && !this.learnerSpeaking) this.request(queued)
  }

  /** A session being torn down must not fire a held request into a closed channel. */
  discard(): void {
    this.queued = null
    this.pendingTools = 0
    this.wantsToolReply = false
    this.learnerSpeaking = false
    this.generation += 1
  }
}
