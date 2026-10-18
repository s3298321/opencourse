import type { CoachStartResult, CoachTranscriptFragment, CoachSessionMetadata, TranscriptTurn } from '@core/types'
import { liveTranscript, validFragment } from '@core/coach/live-transcript'
import { LiveDelegation } from '@core/coach/live-delegation'
import { PlaybackGate } from '@core/coach/playback'
import { WRAPUP_TEXT, WRAPUP_FORCED_TEXT } from '@core/coach/prompt'
import { COACH_MICROPHONE_CONSTRAINTS, configureEchoCancellation } from '@core/coach/audio'

type Ready = Extract<CoachStartResult, { status: 'ok' }>
export type LiveStatus = { kind: 'idle' | 'connecting' | 'live' | 'ended' | 'lost' | 'mic-denied' } |
  { kind: 'wrapping-up'; note: string } | { kind: 'error'; message: string }
export interface SessionView {
  status: LiveStatus
  turns: TranscriptTurn[]
  partial: { role: 'user' | 'assistant'; text: string } | null
  activity: { id: number; text: string; ok: boolean }[]
  elapsedMs: number
  speaking: boolean
  responding: boolean
  unknown: Record<string, number>
}
export const MAX_SESSION_MS = 45 * 60 * 1000
const CLOSE_MS = 5000

/** WebRTC owns media; main owns credentials, persistence, and tool permissions. */
export class LiveSession {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private context: AudioContext | null = null
  private inputMeter: AnalyserNode | null = null
  private outputMeter: AnalyserNode | null = null
  private meterTimer: ReturnType<typeof setInterval> | null = null
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | undefined
  private status: LiveStatus = { kind: 'idle' }
  private activity: SessionView['activity'] = []
  private unknown: Record<string, number> = {}
  private fragments = new Map<string, CoachTranscriptFragment>()
  private unsaved = new Map<string, CoachTranscriptFragment>()
  private flushJob: Promise<void> = Promise.resolve()
  private started = false
  private starting = false
  private stopping = false
  private disposed = false
  private closing = false
  private closed = false
  private stopNow = false
  private stopJob: Promise<void> | null = null
  private connectionJob: Promise<void> | null = null
  private startedAt = 0
  private stoppedAtMs = Infinity
  private eventNumber = 0
  private acks = new Set<string>()
  private rejected = new Set<string>()
  private seen = new Set<string>()
  private metadata: CoachSessionMetadata = { finalization: 'pending' }
  private forcedSave = false
  private restoreChoice: Promise<boolean> | null = null
  private gate = new PlaybackGate()
  private delegation: LiveDelegation

  constructor(private readonly config: Ready, private readonly onChange: () => void) {
    this.delegation = new LiveDelegation({
      send: e => this.send(e),
      tool: (id, name, args) => window.opencourse.runCoachTool(config.sessionId, name, args, id),
      note: (text, ok) => this.note(text, ok), changed: onChange,
      beforeContinue: () => this.restoreChoice ?? Promise.resolve(true),
      diagnostic: (responseId, status) => { void window.opencourse.reportCoachResponse(config.sessionId, { event: 'response.done', responseId, status, wrappingUp: this.stopping }).catch(() => {}) }
    })
    this.unsubscribe = window.opencourse.onCoachShutdown?.(id => { if (id === config.sessionId) this.abandon() })
  }

  view(): SessionView {
    return {
      status: this.status, turns: liveTranscript([...this.fragments.values()], this.config.startedAt), partial: null,
      activity: this.activity, elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      speaking: !this.stopping && this.gate.speaking, responding: this.delegation.busy,
      unknown: this.unknown
    }
  }
  private set(status: LiveStatus): void { this.status = status; this.onChange() }
  private note(text: string, ok: boolean): void {
    this.activity = [...this.activity, { id: ++this.eventNumber, text, ok }].slice(-12)
    this.onChange()
  }
  private send(payload: Record<string, unknown>): string {
    const id = `coach_${++this.eventNumber}`
    if (this.channel?.readyState === 'open' && !this.closed && (!this.closing || payload.type === 'session.close')) {
      this.channel.send(JSON.stringify({ ...payload, event_id: id }))
    }
    return id
  }

  async start(): Promise<void> {
    if (this.starting || this.disposed) return
    this.starting = true
    this.set({ kind: 'connecting' })
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: COACH_MICROPHONE_CONSTRAINTS })
      const tracks = this.mic.getAudioTracks()
      if (!tracks.length || tracks.some(t => t.readyState === 'ended')) throw new Error('No working microphone is available. Choose a microphone and try again.')
      for (const t of tracks) {
        await configureEchoCancellation(t)
        t.onended = () => { if (!this.stopping && !this.disposed) this.lost() }
      }
      if (this.stopping || this.disposed) { this.stopTracks(); return }
      this.mic.getAudioTracks().forEach(t => { t.enabled = false })
      const pc = new RTCPeerConnection()
      this.pc = pc
      this.audio = new Audio()
      this.audio.autoplay = true
      this.audio.onerror = () => this.note('Coach audio playback failed. Start a new session to retry.', false)
      this.context = new AudioContext()
      await this.context.resume()
      this.inputMeter = this.meter(this.mic)
      pc.ontrack = event => {
        if (this.disposed || !this.audio) return
        const stream = event.streams[0] ?? new MediaStream([event.track])
        this.audio.srcObject = stream
        this.outputMeter = this.meter(stream)
        void this.audio.play().catch(() => this.note('Coach audio could not start. Start a new session to retry.', false))
      }
      for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic)
      this.channel = pc.createDataChannel('oai-events')
      this.channel.onmessage = event => this.onEvent(event.data)
      this.channel.onclose = () => { if (!this.closing && !this.disposed) this.lost() }
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(pc.connectionState) && !this.closing && !this.disposed) this.lost()
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (!(await this.wait(() => pc.iceGatheringState === 'complete', 10_000, true))) throw new Error('The microphone connection could not be prepared. Try again.')
      if (this.stopping) return
      this.connectionJob = (async () => {
        const result = await window.opencourse.connectCoachSession(this.config.sessionId, pc.localDescription?.sdp ?? offer.sdp ?? '')
        this.metadata.remoteSessionId = result.remoteSessionId
        // A stop during HTTP creation still completes signalling so session.close can reach the remote.
        await pc.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
        if (!(await this.wait(() => this.started || this.closed, 10_000, true))) throw new Error('GPT-Live did not start. Start a new session to retry.')
      })()
      await this.connectionJob
      if (this.stopping || this.disposed || this.closed) return
      this.meterTimer = setInterval(() => this.sampleAudio(), 50)
    } catch (error) {
      if (this.disposed) return
      const denied = (error as Error).name === 'NotAllowedError'
      this.set(denied ? { kind: 'mic-denied' } : { kind: 'error', message: (error as Error).message })
      await this.finish('failed', (error as Error).message)
    }
  }

  private meter(stream: MediaStream): AnalyserNode {
    const meter = this.context!.createAnalyser()
    meter.fftSize = 512
    this.context!.createMediaStreamSource(stream).connect(meter)
    return meter
  }
  private level(meter: AnalyserNode | null): number {
    if (!meter) return 0
    const samples = new Float32Array(meter.fftSize)
    meter.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
  }
  private sampleAudio(): void {
    if (this.stopping || this.disposed) return
    this.gate.sample(this.level(this.inputMeter), this.level(this.outputMeter), Date.now())
    if (this.audio) this.audio.muted = this.gate.muted
    this.onChange()
  }
  interrupt(): void {
    if (!this.started || this.stopping || this.disposed) return
    this.gate.interrupt()
    if (this.audio) this.audio.muted = true
    this.send({ type: 'session.instructions.append', delegation_id: null,
      content: 'Stop speaking now and listen. Wait for the learner’s next utterance before answering again. Do not resume the interrupted answer when background work returns.' })
    this.onChange()
  }

  private onEvent(data: unknown): void {
    if (this.disposed || typeof data !== 'string') return
    let event: Record<string, any>
    try { event = JSON.parse(data) } catch { return }
    if (!event || typeof event.type !== 'string') return
    if (typeof event.event_id === 'string') {
      if (this.seen.has(event.event_id)) return
      this.seen.add(event.event_id)
    }
    if (event.client_event_id) this.acks.add(event.client_event_id)
    switch (event.type) {
      case 'session.started':
        if (this.started) break
        this.started = true
        this.startedAt ||= Date.now()
        if (!this.stopping) {
          this.mic?.getAudioTracks().forEach(t => { t.enabled = true })
          this.set({ kind: 'live' })
          this.capTimer = setTimeout(() => void this.stop(), MAX_SESSION_MS)
        }
        break
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const fragment = { eventId: event.event_id, role: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant', text: event.delta, startMs: event.start_ms, endMs: event.end_ms }
        if (validFragment(fragment) && !(fragment.role === 'assistant' && fragment.startMs >= this.stoppedAtMs)) {
          this.fragments.set(fragment.eventId, fragment)
          this.unsaved.set(fragment.eventId, fragment)
          this.scheduleFlush()
        }
        break
      }
      case 'response.event':
        if (this.forcedSave && event.event?.type === 'response.output_item.done' && event.event.item?.type === 'function_call') {
          this.forcedSave = false
          const id = this.send({ type: 'session.update', session: { delegation: { type: 'responses', responses: { tool_choice: 'auto' } } } })
          this.restoreChoice = this.wait(() => this.acks.has(id) || this.rejected.has(id), 5000).then(ready => ready && !this.rejected.has(id))
        }
        this.delegation.handle(event); this.scheduleFlush(); break
      case 'session.usage.updated':
        if (Number.isFinite(event.usage?.seconds)) this.metadata.voiceSeconds = event.usage.seconds
        this.scheduleFlush()
        break
      case 'session.closed':
        this.closed = true
        this.metadata.finalization = 'confirmed'
        this.metadata.closeReason = event.reason
        if (Number.isFinite(event.usage?.seconds)) this.metadata.voiceSeconds = event.usage.seconds
        if (!this.closing && !this.stopping) {
          this.set({ kind: 'lost' })
          void this.finish('failed', `The voice session ended (${String(event.reason)}).`)
        }
        break
      case 'error': {
        const error = event.error ?? {}
        const clientEventId = error.client_event_id ?? event.client_event_id
        if (clientEventId) { this.rejected.add(clientEventId); this.delegation.reject(clientEventId) }
        // Do not log raw provider messages: they may contain prompt or tool contents.
        void window.opencourse.reportCoachResponse(this.config.sessionId, {
          event: 'session.error', clientEventId, errorCode: error.code, errorType: error.type,
          wrappingUp: this.stopping, pendingTools: this.delegation.pendingTools
        }).catch(() => {})
        this.note(error.code === 'responses_validation_failed'
          ? `GPT-Live could not use the coaching backend. Check model access for ${this.config.backendModel} and start a new session.`
          : 'GPT-Live could not complete a request. Try again or start a new session.', false)
        if (error.code === 'responses_validation_failed') {
          this.set({ kind: 'error', message: 'The coaching backend is unavailable. Check your API model access.' })
          void this.finish('failed', 'The coaching backend configuration was rejected.')
        }
        break
      }
      default:
        if (!['session.updated', 'session.delegation.created', 'session.instructions.appended', 'session.thinking.appended', 'session.commentary.appended', 'session.input_audio.muted', 'session.input_audio.unmuted'].includes(event.type)) {
          this.unknown[event.type] = (this.unknown[event.type] ?? 0) + 1
        }
    }
    this.onChange()
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 3000)
  }
  private flush(): Promise<void> {
    this.flushJob = this.flushJob.then(async () => {
      const batch = [...this.unsaved.values()].slice(0, 2000)
      const metadata = { ...this.metadata, backendUsage: { ...this.delegation.usage } }
      try {
        await window.opencourse.saveCoachFragments(this.config.sessionId, batch, metadata)
        for (const f of batch) this.unsaved.delete(f.eventId)
      } catch { /* Retain the batch for a retry or final flush. */ }
    })
    return this.flushJob
  }
  private async wait(predicate: () => boolean, milliseconds: number, duringStop = false): Promise<boolean> {
    const end = Date.now() + milliseconds
    while (!predicate() && Date.now() < end && !this.disposed && (duringStop || !this.stopNow)) await new Promise(resolve => setTimeout(resolve, 25))
    return predicate()
  }
  private stopTracks(): void { this.mic?.getTracks().forEach(t => { t.enabled = false; t.stop() }) }
  private lost(): void {
    this.set({ kind: 'lost' })
    void this.finish('failed', 'The connection dropped.')
  }

  stop(options: { skipWrapUp?: boolean } = {}): Promise<void> {
    if (options.skipWrapUp) this.stopNow = true
    if (this.stopJob) { if (this.stopNow) this.set({ kind: 'ended' }); return this.stopJob }
    if (this.disposed) return Promise.resolve()
    this.stopping = true
    this.stoppedAtMs = Math.min(this.stoppedAtMs, this.startedAt ? Date.now() - this.startedAt : 0)
    this.stopTracks()
    if (this.audio) this.audio.muted = true
    if (this.capTimer) clearTimeout(this.capTimer)
    if (this.stopNow) this.set({ kind: 'ended' })
    this.stopJob = this.wrapAndClose()
    return this.stopJob
  }

  private async wrapAndClose(): Promise<void> {
    let error: string | undefined
    if (!this.stopNow && this.started && this.channel?.readyState === 'open') {
      this.set({ kind: 'wrapping-up', note: 'Saving what we worked on…' })
      this.send({ type: 'session.input_audio.mute' })
      this.send({ type: 'session.instructions.append', delegation_id: null, content: 'The coaching session is ending. Stay silent. Do not initiate more backend tasks. The application is saving notes.' })
      const drained = await this.wait(() => !this.delegation.busy, 10_000)
      const before = this.delegation.writes
      if (drained) for (let attempt = 0; attempt < 2 && !this.stopNow && !this.closed; attempt++) {
        const deadline = Date.now() + 20_000
        if (attempt === 1) {
          this.forcedSave = true
          const id = this.send({ type: 'session.update', session: { delegation: { type: 'responses', responses: { tool_choice: { type: 'function', name: 'write_file' } } } } })
          if (!(await this.wait(() => this.acks.has(id) || this.rejected.has(id), Math.max(0, deadline - Date.now()))) || this.rejected.has(id)) break
        }
        const completed = this.delegation.completions
        this.send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: attempt ? WRAPUP_FORCED_TEXT : WRAPUP_TEXT }] } })
        this.delegation.request()
        await this.wait(() => this.delegation.completions > completed && !this.delegation.busy, Math.max(0, deadline - Date.now()))
        if (this.delegation.writes > before || this.delegation.busy) break
      }
      if (!this.stopNow && this.delegation.writes === before) error = 'The coach could not save notes on the way out.'
    }
    if (error) this.note(error, false)
    await this.finish('ended', error)
    this.set({ kind: 'ended' })
  }

  private finishJob: Promise<void> | null = null
  private finish(status: 'ended' | 'failed', error?: string): Promise<void> {
    if (this.finishJob) return this.finishJob
    this.stopping = true
    this.stoppedAtMs = Math.min(this.stoppedAtMs, this.startedAt ? Date.now() - this.startedAt : 0)
    this.stopTracks()
    if (this.audio) this.audio.muted = true
    this.finishJob = (async () => {
      // Keep a pending handshake alive long enough to close a late successful creation.
      if (this.connectionJob && !this.started && !this.closed) await this.connectionJob.catch(() => {})
      this.closing = true
      this.delegation.dispose()
      if (!this.closed && this.started && this.channel?.readyState === 'open') {
        this.send({ type: 'session.close' })
        await this.wait(() => this.closed, CLOSE_MS, true)
      }
      if (!this.closed) {
        this.metadata.finalization = 'unconfirmed'
        if (this.started) error = [error, 'Voice session finalization was not confirmed.'].filter(Boolean).join(' ')
      }
      await this.flush()
      const fragments = [...this.unsaved.values()]
      // Final batches remain bounded even after an extended persistence failure.
      for (let i = 0; i < fragments.length; i += 2000) {
        try { await window.opencourse.saveCoachFragments(this.config.sessionId, fragments.slice(i, i + 2000)) } catch { error = [error, 'Some transcript text could not be saved.'].filter(Boolean).join(' '); break }
      }
      this.disposed = true
      if (this.flushTimer) clearTimeout(this.flushTimer)
      if (this.capTimer) clearTimeout(this.capTimer)
      if (this.meterTimer) clearInterval(this.meterTimer)
      this.unsubscribe?.()
      this.channel?.close()
      this.pc?.close()
      if (this.audio) this.audio.srcObject = null
      void this.context?.close().catch(() => {})
      try { await window.opencourse.endCoachSession(this.config.sessionId, { status, error, metadata: { ...this.metadata, backendUsage: this.delegation.usage } }) } catch { /* Main's crash sweep handles an unavailable renderer. */ }
    })()
    return this.finishJob
  }
  abandon(): void { this.stopNow = true; void this.finish('failed', 'The window closed.') }
}
