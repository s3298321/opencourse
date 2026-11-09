import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VoicePreview } from '../src/renderer/coach/voice-preview'
import { VOICE_PREVIEW_MS, voicePreviewInstructions } from '../src/core/coach/voice-preview'

let channel: any, pc: any, context: any, audio: any, track: any, source: any, connect: any
const events: any[] = []
const event = (type: string) => channel.onmessage({ data: JSON.stringify({ type }) })

beforeEach(() => {
  vi.useFakeTimers()
  events.length = 0
  track = { stop: vi.fn() }
  source = { offset: { value: 1 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
  const stream = { getTracks: () => [track] }
  context = {
    createConstantSource: () => source, createMediaStreamDestination: () => ({ stream }),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {})
  }
  audio = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null, muted: false }
  channel = { readyState: 'open', close: vi.fn(), send: vi.fn((raw: string) => {
    const message = JSON.parse(raw); events.push(message)
    if (message.type === 'session.close') event('session.closed')
  }) }
  pc = {
    iceGatheringState: 'complete', localDescription: { sdp: 'v=0 offer' },
    addTrack: vi.fn(), createDataChannel: () => channel,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'v=0 offer' })),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => { event('session.started'); pc.ontrack({ streams: [stream] }) }),
    close: vi.fn()
  }
  vi.stubGlobal('AudioContext', class { constructor() { return context } })
  vi.stubGlobal('Audio', class { constructor() { return audio } })
  vi.stubGlobal('RTCPeerConnection', class { constructor() { return pc } })
  connect = vi.fn(async () => ({ answerSdp: 'v=0 answer' }))
  vi.stubGlobal('opencourse', { previewCoachVoice: connect })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('uses a silent track, plays the chosen voice and automatically closes and releases resources', async () => {
  const changed = vi.fn()
  const preview = new VoicePreview(changed)
  preview.start('sillage')
  await vi.advanceTimersByTimeAsync(0)
  expect(connect).toHaveBeenCalledWith('sillage', 'v=0 offer')
  expect(source.offset.value).toBe(0)
  expect(pc.addTrack).toHaveBeenCalledWith(track, expect.anything())
  expect(audio.play).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledWith('playing')
  expect(events.filter(e => e.type === 'session.commentary.append')).toHaveLength(1)
  const greeting = events.find(e => e.type === 'session.commentary.append').content
  expect(greeting).toContain('Bonjour')
  expect(greeting).toBe(voicePreviewInstructions('brise'))
  await vi.advanceTimersByTimeAsync(VOICE_PREVIEW_MS)
  expect(events.filter(e => e.type === 'session.close')).toHaveLength(1)
  expect(track.stop).toHaveBeenCalledOnce()
  expect(pc.close).toHaveBeenCalledOnce()
  expect(context.close).toHaveBeenCalledOnce()
  expect(audio.srcObject).toBeNull()
  expect(changed).toHaveBeenLastCalledWith('idle')
  await preview.stop()
  expect(pc.close).toHaveBeenCalledOnce()
})

it('closes a late connection after cancellation without playing audio or requesting a greeting', async () => {
  let resolve!: (result: { answerSdp: string }) => void
  connect.mockImplementation(() => new Promise(done => { resolve = done }))
  const preview = new VoicePreview(vi.fn())
  preview.start('marin')
  await vi.advanceTimersByTimeAsync(0)
  const stopped = preview.stop()
  resolve({ answerSdp: 'v=0 answer' })
  await stopped
  expect(pc.setRemoteDescription).toHaveBeenCalled()
  expect(audio.play).not.toHaveBeenCalled()
  expect(events.map(e => e.type)).toEqual(['session.close'])
  expect(track.stop).toHaveBeenCalledOnce()
})

it('reports API failures and releases resources', async () => {
  connect.mockRejectedValueOnce(new Error('Preview unavailable'))
  const changed = vi.fn()
  new VoicePreview(changed).start('brise')
  await vi.advanceTimersByTimeAsync(0)
  expect(changed).toHaveBeenCalledWith('loading', 'Preview unavailable')
  expect(changed).toHaveBeenLastCalledWith('idle')
  expect(pc.close).toHaveBeenCalledOnce()
  expect(track.stop).toHaveBeenCalledOnce()
})

it('times out a session that never starts and frees the audio connection', async () => {
  pc.setRemoteDescription.mockImplementation(async () => {})
  const changed = vi.fn()
  new VoicePreview(changed).start('cedar')
  await vi.advanceTimersByTimeAsync(10_100)
  expect(changed).toHaveBeenCalledWith('loading', expect.stringContaining('did not start'))
  expect(pc.close).toHaveBeenCalledOnce()
  expect(track.stop).toHaveBeenCalledOnce()
})

it('cleans up when playback is blocked', async () => {
  audio.play.mockRejectedValueOnce(new Error('NotAllowedError'))
  const changed = vi.fn()
  new VoicePreview(changed).start('cedar')
  await vi.advanceTimersByTimeAsync(0)
  expect(changed).toHaveBeenCalledWith('loading', expect.stringContaining('could not play'))
  expect(events.map(e => e.type)).toContain('session.close')
  expect(pc.close).toHaveBeenCalledOnce()
})
