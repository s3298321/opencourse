/**
 * The live conversation, from the renderer's side.
 *
 * A plain class rather than a hook: it owns a peer connection, a microphone and
 * a data channel, none of which want to be re-created when React re-renders.
 * The component holds one of these in a ref and mirrors only coarse status.
 *
 * What this file does *not* hold is a credential. Main mints the ephemeral
 * secret and does the SDP exchange; the renderer gets an answer SDP and a
 * session id. Audio flows straight from here to OpenAI over WebRTC, which is
 * not something CSP governs - `connect-src 'self'` is untouched.
 *
 * Transcript interpretation and speech validation live in `@core/coach`,
 * so their behaviour can be tested without a real connection.
 */
import { emptySessionState, pendingTurns, reduceRealtimeEvent, transcriptOf } from '@core/coach/events'
import type { SessionEffect, SessionState } from '@core/coach/events'
import { WRAPUP_FORCED_TEXT, WRAPUP_TEXT } from '@core/coach/prompt'
import { ResponseGate } from '@core/coach/responses'
import { COACH_MICROPHONE_CONSTRAINTS, COACH_TURN_DETECTION, configureEchoCancellation } from '@core/coach/audio'
import type { CoachStartResult, TranscriptTurn } from '@core/types'

type Ready = Extract<CoachStartResult, { status: 'ok' }>

export type LiveStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'wrapping-up'; note: string }
  | { kind: 'ended' }
  | { kind: 'lost' }
  | { kind: 'mic-denied' }
  | { kind: 'error'; message: string }

export interface SessionView {
  status: LiveStatus
  turns: TranscriptTurn[]
  /** What is being said right now, not yet a turn. */
  partial: { role: 'user' | 'assistant'; text: string } | null
  activity: { id: number; text: string; ok: boolean }[]
  elapsedMs: number
  speaking: boolean
  responding: boolean
  /** Event types the reducer had no case for. A drift alarm, shown under a fold. */
  unknown: Record<string, number>
}

/** Turns are flushed on a timer so a crash costs one exchange, not a session. */
const FLUSH_MS = 3000
const FLUSH_AT_TURNS = 8

/** How long to wait for the coach to write its notes before giving up on it. */
const WRAPUP_TIMEOUT_MS = 20_000

/** Realtime bills by the minute, and a forgotten tab is a real way to spend money. */
export const MAX_SESSION_MS = 45 * 60 * 1000

export class RealtimeSession {
  private readonly config: Ready
  private readonly onChange: () => void

  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio: HTMLAudioElement | null = null

  private state: SessionState = emptySessionState()
  private unsaved: TranscriptTurn[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private configureTimer: ReturnType<typeof setTimeout> | null = null
  private configured = false

  /** In-flight tool calls, so a stop can wait for the write to land. */
  private readonly pending = new Map<string, Promise<void>>()

  /** Owns the one-response-at-a-time rule. See core/coach/responses.ts. */
  private readonly responses = new ResponseGate((payload) => this.send(payload))
  private outputPlaying = false
  private playbackResponseId = ''
  private generatingResponseId = ''
  private readonly interruptedResponses = new Set<string>()

  private status: LiveStatus = { kind: 'idle' }
  private partial: SessionView['partial'] = null
  private activity: SessionView['activity'] = []
  private activityId = 0
  private startedAt = 0
  private stopping = false
  private disposed = false

  /** Wrap-up bookkeeping: at most two asks, then it is let go. */
  private wrapUpAttempts = 0
  private wrapUpToolCalls = 0
  private wrapUpResolve: (() => void) | null = null

  constructor(config: Ready, onChange: () => void) {
    this.config = config
    this.onChange = onChange
  }

  view(): SessionView {
    return {
      status: this.status,
      turns: transcriptOf(this.state),
      partial: this.partial,
      activity: this.activity,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      speaking: this.outputPlaying,
      responding: this.responses.busy || this.pending.size > 0,
      unknown: this.state.unknown
    }
  }

  private set(status: LiveStatus): void {
    this.status = status
    this.onChange()
  }

  private note(text: string, ok: boolean): void {
    this.activityId += 1
    this.activity = [...this.activity, { id: this.activityId, text, ok }].slice(-12)
    this.onChange()
  }

  /**
   * Opens the microphone, then the connection.
   *
   * getUserMedia first, deliberately: a refusal should cost nothing, and it is
   * the failure most likely to happen.
   */
  async start(): Promise<void> {
    if (this.pc || this.disposed) return
    this.set({ kind: 'connecting' })

    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: COACH_MICROPHONE_CONSTRAINTS
      })
      for (const track of this.mic.getAudioTracks()) await configureEchoCancellation(track)
    } catch (err) {
      this.stopTracks()
      const name = (err as Error).name
      this.set(name === 'NotAllowedError' ? { kind: 'mic-denied' } : { kind: 'error', message: (err as Error).message })
      return
    }
    if (this.disposed) {
      this.stopTracks()
      return
    }
    // Do not send microphone audio until the server confirms automatic turn
    // control. Keep it enabled for the entire live conversation after that.
    this.setMicrophone(false)

    try {
      const pc = new RTCPeerConnection()
      this.pc = pc

      // A MediaStream on srcObject is not a fetched URL, so media-src is not
      // involved and nothing about the CSP has to change.
      const audio = new Audio()
      audio.autoplay = true
      audio.onerror = () => this.note('Coach audio playback failed. Start a new session to reconnect.', false)
      this.audio = audio
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null
        void audio.play().catch(() => {
          this.note('Coach audio could not start. Start a new session to retry playback.', false)
        })
      }

      for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic)

      const channel = pc.createDataChannel('oai-events')
      this.channel = channel
      channel.onmessage = (event) => this.onEvent(event.data)
      channel.onopen = () => {
        this.startedAt = Date.now()
        this.send({
          type: 'session.update',
          session: { type: 'realtime', audio: { input: {
            turn_detection: COACH_TURN_DETECTION,
            noise_reduction: { type: 'far_field' }
          } } }
        })
        this.configureTimer = setTimeout(() => {
          const message = 'The coach did not confirm its audio settings. Start a new session to retry.'
          this.set({ kind: 'error', message })
          void this.teardown('failed', message)
        }, 10_000)
        // A session left running is a session still being billed.
        this.capTimer = setTimeout(() => void this.stop(), MAX_SESSION_MS)
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.onLost()
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const { answerSdp } = await window.opencourse.connectCoachSession(this.config.sessionId, offer.sdp ?? '')
      if (this.disposed) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (err) {
      this.set({ kind: 'error', message: (err as Error).message })
      await this.teardown('failed', (err as Error).message)
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(payload))
  }

  private setMicrophone(enabled: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = enabled
  }

  /** A deliberate interruption, also used for a confirmed new learner turn. */
  interrupt(): void {
    if (this.stopping || this.disposed) return
    if (this.responses.busy && this.generatingResponseId) this.rememberInterruption(this.generatingResponseId)
    if (this.outputPlaying && this.playbackResponseId) this.rememberInterruption(this.playbackResponseId)
    if (this.audio && (this.responses.busy || this.outputPlaying)) this.audio.muted = true
    this.responses.interrupt()
    if (this.outputPlaying) {
      // Stop locally at once; WebRTC clear truncates unheard server history.
      if (this.audio) this.audio.muted = true
      this.send({ type: 'output_audio_buffer.clear' })
      this.outputPlaying = false
    }
    this.onChange()
  }

  private rememberInterruption(responseId: string): void {
    this.interruptedResponses.add(responseId)
    if (this.interruptedResponses.size > 100) this.interruptedResponses.delete(this.interruptedResponses.values().next().value as string)
  }

  /** Waits for the conversation to go quiet, so a request will not be refused. */
  private async waitUntilIdle(ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms
    while (this.responses.busy && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  }

  private onEvent(data: unknown): void {
    if (typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    if (parsed && typeof parsed === 'object') {
      const event = parsed as Record<string, unknown>
      const type = event['type']
      if (type === 'session.updated' && !this.configured) {
        const session = event['session'] as { audio?: { input?: { turn_detection?: Record<string, unknown> } } } | undefined
        const policy = session?.audio?.input?.turn_detection
        if (policy && Object.entries(COACH_TURN_DETECTION).every(([key, value]) => policy[key] === value)) {
          this.configured = true
          if (this.configureTimer) clearTimeout(this.configureTimer)
          if (!this.stopping && !this.disposed) {
            this.setMicrophone(true)
            this.set({ kind: 'live' })
          }
        }
      }
      const responseId = typeof event['response_id'] === 'string' ? event['response_id'] : ''
      if (type === 'input_audio_buffer.speech_started' && this.configured && !this.stopping) {
        // The server cancels and truncates WebRTC playback itself. Only
        // invalidate stale tool continuations; do not send a second cancel.
        this.responses.speechStarted()
      }
      if (type === 'input_audio_buffer.speech_stopped') this.responses.speechStopped()
      if (type === 'output_audio_buffer.started') {
        this.playbackResponseId = responseId
        if (this.interruptedResponses.has(responseId)) {
          this.outputPlaying = false
          this.send({ type: 'output_audio_buffer.clear' })
        } else {
          this.outputPlaying = true
          if (this.audio && !this.stopping) this.audio.muted = false
        }
      }
      if ((type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') &&
        (!responseId || !this.playbackResponseId || responseId === this.playbackResponseId)) {
        this.outputPlaying = false
      }
    }
    const step = reduceRealtimeEvent(this.state, parsed)
    this.state = step.state
    for (const effect of step.effects) this.apply(effect)
    this.onChange()
  }

  private apply(effect: SessionEffect): void {
    switch (effect.kind) {
      case 'partial':
        if (effect.text) this.partial = { role: effect.role, text: effect.text }
        else if (this.partial?.role === effect.role) this.partial = null
        return

      case 'turn':
        this.partial = null
        this.unsaved.push(effect.turn)
        if (this.unsaved.length >= FLUSH_AT_TURNS) this.flush()
        else this.scheduleFlush()
        return

      case 'tool': {
        const { callId, name, arguments: args } = effect.call
        const generation = this.responses.toolStarted()
        const submit = (output: string): void => {
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output }
          })
        }
        const run = window.opencourse
          .runCoachTool(this.config.sessionId, name, args)
          .then((result) => {
            this.note(result.summary, result.ok)
            if (this.status.kind === 'wrapping-up') this.wrapUpToolCalls += 1
            submit(result.output)
          })
          .catch((err: Error) => {
            this.note(`could not run ${name}`, false)
            submit(JSON.stringify({ ok: false, error: err.message }))
          })
          .finally(() => {
            this.pending.delete(callId)
            // Outputs go back as they land; only the last of a batch asks for
            // a reply. See core/coach/responses.ts for why.
            this.responses.toolFinished(generation)
          })
        this.pending.set(callId, run)
        return
      }

      case 'error':
        // Not every error is fatal - the API sends recoverable ones too. Only a
        // connection state change tears a session down.
        this.note(effect.message, false)
        return

      case 'responseStarted':
        this.generatingResponseId = effect.responseId
        if (this.responses.isCancelling) this.rememberInterruption(effect.responseId)
        this.responses.started(effect.responseId)
        return

      case 'responseDone':
        if (effect.status === 'failed' || effect.status === 'incomplete') {
          this.note(`Coach reply stopped before finishing${effect.reason ? `: ${effect.reason}` : '.'}`, false)
        } else if (effect.status === 'cancelled' && !this.responses.isCancelling && !this.stopping) {
          this.note('The service interrupted the coach’s reply before it finished.', false)
        }
        this.responses.done(effect.responseId)
        if (this.status.kind === 'wrapping-up') this.wrapUpResolve?.()
        return

      case 'unknown':
        return
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.unsaved.length) return
    const batch = this.unsaved
    this.unsaved = []
    // The (session_id, seq) primary key makes a re-send free, so a failed flush
    // is put back rather than dropped.
    void window.opencourse.saveCoachTurns(this.config.sessionId, batch).catch(() => {
      this.unsaved = [...batch, ...this.unsaved]
    })
  }

  private onLost(): void {
    if (this.stopping || this.disposed) return
    this.flush()
    this.set({ kind: 'lost' })
    // There is no channel left to ask for a wrap-up on, so do not pretend.
    void this.teardown('failed', 'the connection dropped')
  }

  /** Waits for one response to finish, or for the clock to run out. */
  private waitForResponse(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms)
      const self = this
      function finish(): void {
        clearTimeout(timer)
        self.wrapUpResolve = null
        resolve()
      }
      this.wrapUpResolve = finish
    })
  }

  /**
   * Ends the session, giving the coach a last chance to write its notes.
   *
   * The order matters. The microphone is stopped first so the learner cannot
   * keep talking into a closing session, but the data channel stays open. Any
   * tool call already in flight is drained before the wrap-up is asked for -
   * stopping mid-write must still land the write.
   */
  async stop(options: { skipWrapUp?: boolean } = {}): Promise<void> {
    if (this.stopping || this.disposed) return
    this.stopping = true
    if (this.capTimer) clearTimeout(this.capTimer)
    if (this.configureTimer) clearTimeout(this.configureTimer)

    const connected = this.channel?.readyState === 'open'
    this.setMicrophone(false)
    this.stopTracks()
    this.responses.speechStopped()
    if (connected) this.send({
      type: 'session.update', session: { type: 'realtime', audio: { input: {
        turn_detection: { ...COACH_TURN_DETECTION, create_response: false, interrupt_response: false }
      } } }
    })
    // Tool continuations during wrap-up must stay silent too.
    this.responses.setDefaults({ output_modalities: ['text'] })
    if (this.audio) this.audio.muted = true

    if (connected && !options.skipWrapUp) {
      this.set({ kind: 'wrapping-up', note: 'Saving what we worked on…' })
      await Promise.allSettled([...this.pending.values()])

      this.wrapUpToolCalls = 0
      for (this.wrapUpAttempts = 0; this.wrapUpAttempts < 2; this.wrapUpAttempts += 1) {
        const forced = this.wrapUpAttempts === 1
        // Let whatever the coach was mid-sentence on finish, or the wrap-up
        // request is refused and the notes never get written.
        await this.waitUntilIdle()
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: forced ? WRAPUP_FORCED_TEXT : WRAPUP_TEXT }]
          }
        })
        this.responses.request({
          output_modalities: ['text'],
          ...(forced ? { tool_choice: { type: 'function', name: 'write_file' } } : {})
        })

        await this.waitForResponse(WRAPUP_TIMEOUT_MS)
        await Promise.allSettled([...this.pending.values()])
        if (this.wrapUpToolCalls > 0) break
      }
    }

    this.flush()
    const failedToSave = !options.skipWrapUp && connected && this.wrapUpToolCalls === 0
    await this.teardown('ended', failedToSave ? 'the coach saved nothing on the way out' : undefined)
    this.set({ kind: 'ended' })
  }

  private stopTracks(): void {
    for (const track of this.mic?.getTracks() ?? []) track.stop()
  }

  private async teardown(status: 'ended' | 'failed', error?: string): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.capTimer) clearTimeout(this.capTimer)
    if (this.configureTimer) clearTimeout(this.configureTimer)

    this.responses.discard()
    this.stopTracks()
    try {
      this.channel?.close()
      this.pc?.close()
    } catch {
      /* already gone */
    }
    if (this.audio) this.audio.srcObject = null
    this.channel = null
    this.pc = null
    this.mic = null

    // Half-said speech is better than losing the end of a conversation.
    const leftovers = [...this.unsaved, ...pendingTurns(this.state)]
    this.unsaved = []
    try {
      await window.opencourse.endCoachSession(this.config.sessionId, {
        status,
        ...(error ? { error } : {}),
        ...(leftovers.length ? { turns: leftovers } : {})
      })
    } catch {
      // The sweep on the next database open closes anything left live.
    }
  }

  /** For an unmount: end it now, no wrap-up, no waiting. */
  abandon(): void {
    if (this.disposed) return
    this.stopping = true
    void this.teardown('failed', 'the window closed')
  }
}
