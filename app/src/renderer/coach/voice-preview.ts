import { VOICE_PREVIEW_INSTRUCTIONS, VOICE_PREVIEW_MS } from '@core/coach/voice-preview'

export type VoicePreviewState = 'loading' | 'playing' | 'idle'

/** Silent input keeps Live's continuous audio clock running without opening a microphone. */
export class VoicePreview {
  private pc: RTCPeerConnection | null = null
  private context: AudioContext | null = null
  private source: ConstantSourceNode | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private channel: RTCDataChannel | null = null
  private started = false
  private closed = false
  private stopped = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private job: Promise<void> | null = null
  private stopJob: Promise<void> | null = null

  constructor(private changed: (state: VoicePreviewState, error?: string) => void) {}

  start(voice: string): void {
    if (this.job || this.stopped) return
    this.changed('loading')
    this.job = this.connect(voice).catch(error => {
      if (!this.stopped) this.changed('loading', (error as Error).message)
      void this.stop()
    })
  }

  private async connect(voice: string): Promise<void> {
    this.context = new AudioContext()
    this.source = this.context.createConstantSource()
    this.source.offset.value = 0
    const destination = this.context.createMediaStreamDestination()
    this.source.connect(destination)
    this.source.start()
    this.stream = destination.stream
    this.audio = new Audio()
    this.audio.autoplay = true
    this.audio.onerror = () => this.fail('The voice preview could not play. Try again.')
    const pc = this.pc = new RTCPeerConnection()
    pc.ontrack = event => {
      if (this.stopped || !this.audio) return
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void this.audio.play().then(() => {
        if (!this.stopped) this.changed('playing')
      }).catch(() => this.fail('The voice preview could not play. Try again.'))
    }
    pc.onconnectionstatechange = () => {
      if (!this.stopped && ['failed', 'disconnected'].includes(pc.connectionState)) this.fail('The voice preview connection was lost. Try again.')
    }
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream)
    this.channel = pc.createDataChannel('oai-events')
    this.channel.onclose = () => { if (!this.stopped) this.fail('The voice preview connection closed. Try again.') }
    this.channel.onmessage = event => {
      let message: { type?: string }
      try { message = JSON.parse(event.data) } catch { return }
      if (message?.type === 'session.started' && !this.started) {
        this.started = true
        if (!this.stopped) {
          this.send({ type: 'session.commentary.append', delegation_id: null, content: VOICE_PREVIEW_INSTRUCTIONS })
          this.timer = setTimeout(() => void this.stop(), VOICE_PREVIEW_MS)
        }
      } else if (message?.type === 'session.closed') {
        this.closed = true
        void this.stop()
      } else if (message?.type === 'error') this.fail('GPT-Live could not preview this voice. Try again.')
    }
    await this.context.resume()
    if (this.stopped) return
    await pc.setLocalDescription(await pc.createOffer())
    if (!(await this.wait(() => pc.iceGatheringState === 'complete' || this.stopped, 10_000))) throw new Error('Could not prepare the voice preview connection.')
    if (this.stopped) return
    const result = await window.opencourse.previewCoachVoice(voice, pc.localDescription?.sdp ?? '')
    // Even if cancelled during HTTP creation, finish signalling so session.close can reach Live.
    await pc.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
    if (!(await this.wait(() => this.started || this.closed, 10_000))) throw new Error('The voice preview did not start. Try again.')
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ ...event, event_id: crypto.randomUUID() }))
  }

  private fail(error: string): void {
    if (this.stopped) return
    this.changed('loading', error)
    void this.stop()
  }

  private async wait(ready: () => boolean, ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (!ready() && !this.disposed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
    return ready()
  }

  stop(): Promise<void> {
    if (this.stopJob) return this.stopJob
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.audio) { this.audio.muted = true; this.audio.pause() }
    this.stopJob = (async () => {
      await this.job
      try {
        if (this.started && !this.closed) {
          this.send({ type: 'session.close' })
          await this.wait(() => this.closed, 2000)
        }
      } finally {
        this.disposed = true
        this.channel?.close()
        this.pc?.close()
        this.stream?.getTracks().forEach(track => track.stop())
        this.source?.stop()
        if (this.audio) this.audio.srcObject = null
        await this.context?.close().catch(() => {})
        this.changed('idle')
      }
    })()
    return this.stopJob
  }
}
