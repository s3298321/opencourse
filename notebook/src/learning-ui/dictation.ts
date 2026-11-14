export interface DictationTransport {
  begin?: (id: string) => Promise<void>
  connect: (id: string, sdp: string) => Promise<{ answerSdp: string }>
  end?: (id: string) => Promise<void>
  onEnded?: (handler: (id: string) => void) => () => void
}
export type DictationPhase = 'idle' | 'connecting' | 'listening' | 'finishing'

/** One peer and one manually committed audio turn per press of the microphone. */
export class Dictation {
  readonly id = crypto.randomUUID()
  private phase: DictationPhase = 'connecting'
  private captureReleased = false
  private stream?: MediaStream
  private peer?: RTCPeerConnection
  private channel?: RTCDataChannel
  private sender?: RTCRtpSender
  private timer?: ReturnType<typeof setTimeout>
  private commitTimer?: ReturnType<typeof setTimeout>
  private meter?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void
  private fragments = new Map<string, string>()
  constructor(private transport: DictationTransport, private limit: number, private callbacks: {
    phase: (phase: DictationPhase) => void
    draft: (text: string) => void
    speech: (audible: boolean) => void
    done: (notice: string) => void
  }) {}

  get active() { return this.phase !== 'idle' }

  async start() {
    const { transport } = this
    this.callbacks.phase('connecting')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined')
        throw new Error('Microphone access requires a supported browser on HTTPS or localhost.')
      this.unsubscribe = transport.onEnded?.(id => { if (id === this.id) this.close('Dictation ended.') })
      await transport.begin?.(this.id)
      if (!this.active) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!this.active) { stream.getTracks().forEach(t => t.stop()); return }
      this.stream = stream
      const track = stream.getAudioTracks()[0]
      if (!track || track.readyState === 'ended') throw new Error('No working microphone is available.')
      track.enabled = false
      track.onended = () => this.close('Microphone disconnected.')
      const peer = new RTCPeerConnection()
      this.peer = peer
      this.sender = peer.addTrack(track, stream)
      const channel = peer.createDataChannel('oai-events')
      this.channel = channel
      channel.onopen = () => {
        if (this.phase !== 'connecting') return
        clearTimeout(this.timer)
        this.phase = 'listening'
        track.enabled = true
        this.callbacks.phase(this.phase)
        this.meter = setInterval(() => { void this.sampleLevel() }, 180)
      }
      channel.onmessage = event => this.receive(event.data)
      channel.onclose = () => this.close('Dictation disconnected. Your draft is available.')
      peer.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState))
          this.close('Dictation disconnected. Your draft is available.')
      }
      this.timer = setTimeout(() => this.close('The microphone connection timed out. Try again.'), 30000)
      const offer = await peer.createOffer()
      if (!this.active) return
      await peer.setLocalDescription(offer)
      if (!this.active) return
      const { answerSdp } = await transport.connect(this.id, peer.localDescription?.sdp ?? offer.sdp ?? '')
      if (this.active) await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (error) {
      const e = error as Error
      this.close(e.name === 'NotAllowedError' ? 'Allow microphone access to dictate a message.' : e.message)
    }
  }

  private async sampleLevel() {
    try {
      const stats = await this.sender?.getStats()
      if (this.phase !== 'listening') return
      stats?.forEach(stat => {
        if (stat.type === 'media-source' && stat.kind === 'audio') this.callbacks.speech(stat.audioLevel > 0.025)
      })
    } catch { /* Metering is optional on browsers without audio source stats. */ }
  }

  private receive(raw: unknown) {
    if (!this.active || typeof raw !== 'string') return
    let event
    try { event = JSON.parse(raw) } catch { return }
    if (event?.type === 'error' || event?.type === 'conversation.item.input_audio_transcription.failed') {
      this.close('Transcription could not finish. You can edit the text received so far.')
      return
    }
    if (typeof event?.item_id !== 'string') return
    const completed = event.type === 'conversation.item.input_audio_transcription.completed'
    if (completed && typeof event.transcript === 'string') this.fragments.set(event.item_id, event.transcript)
    else if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string')
      this.fragments.set(event.item_id, (this.fragments.get(event.item_id) ?? '') + event.delta)
    else return
    const draft = Array.from(this.fragments.values()).join(' ').trimStart()
    this.callbacks.draft(draft.slice(0, this.limit))
    if (completed && this.phase === 'finishing') this.close('')
    else if (draft.length >= this.limit) this.stop()
  }

  private releaseCapture() {
    clearInterval(this.meter)
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop() })
    this.stream = undefined
    if (!this.captureReleased) {
      this.captureReleased = true
      void this.transport.end?.(this.id).catch(() => {})
    }
  }

  stop() {
    if (this.phase === 'connecting') { this.close(''); return }
    if (this.phase !== 'listening') return
    this.phase = 'finishing'
    this.releaseCapture()
    this.callbacks.speech(false)
    this.callbacks.phase(this.phase)
    // Audio and control use separate WebRTC channels. Let the last audio packets
    // arrive before committing, even though the capture device is already closed.
    this.commitTimer = setTimeout(() => {
      try { this.channel?.send(JSON.stringify({ type: 'input_audio_buffer.commit' })) }
      catch { this.close('Dictation disconnected. Your draft is available.') }
    }, 180)
    this.timer = setTimeout(() => this.close('Final text was delayed. You can edit your draft.'), 3000)
  }

  close(notice = '') {
    if (!this.active) return
    this.phase = 'idle'
    clearTimeout(this.timer)
    clearTimeout(this.commitTimer)
    this.unsubscribe?.()
    this.releaseCapture()
    this.channel?.close()
    this.peer?.close()
    this.callbacks.done(notice)
  }
}
