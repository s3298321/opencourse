import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dictation } from '../src/learning-ui/dictation'
import { holdMic, wantsMic } from '../src/main/mic'
import { normalizePreferences } from '../src/core/preferences'

const track = { enabled: true, stop: vi.fn(), readyState: 'live' }
const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
const getUserMedia = vi.fn(async () => stream)
const channel = { onopen: () => {}, onmessage: (_event: {data: string}) => {}, send: vi.fn(), close: vi.fn() }
const connect = vi.fn(async () => ({ answerSdp: 'v=0 answer' }))
const end = vi.fn(async () => {})
const draft = vi.fn(), done = vi.fn(), phase = vi.fn()
let capture: Dictation
function make(limit = 100) {
  capture = new Dictation({ connect, end }, limit, { draft, done, phase, speech: vi.fn() })
  return capture
}
function transcript(kind: 'delta' | 'completed', text: string) {
  channel.onmessage({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.' + kind,
    item_id: 'turn', ...(kind === 'delta' ? { delta: text } : { transcript: text }) }) })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('RTCPeerConnection', class {
    localDescription = { sdp: 'offer' }
    addTrack() { return { getStats: async () => new Map() } }
    createDataChannel() { return channel }
    async createOffer() { return this.localDescription }
    async setLocalDescription() {}
    async setRemoteDescription() { channel.onopen() }
    close() {}
  })
})
afterEach(() => { capture?.close(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('writes live fragments, stops capture immediately, and reconciles the final correction once', async () => {
  await make().start()
  expect(phase.mock.calls.flat()).toEqual(['connecting', 'listening'])
  transcript('delta', 'A blue')
  transcript('delta', ' pen')
  expect(draft).toHaveBeenLastCalledWith('A blue pen')
  capture.stop()
  expect(track.stop).toHaveBeenCalledOnce()
  expect(phase).toHaveBeenLastCalledWith('finishing')
  expect(end).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(200)
  expect(channel.send).toHaveBeenCalledWith('{"type":"input_audio_buffer.commit"}')
  transcript('completed', 'A blue pin.')
  expect(draft).toHaveBeenLastCalledWith('A blue pin.')
  expect(done).toHaveBeenCalledWith('')
  transcript('delta', 'stale')
  expect(draft).toHaveBeenCalledTimes(3)
  expect(end).toHaveBeenCalledOnce()
})
it('removes leading whitespace from live and final text while preserving spaces and line breaks within it', async () => {
  await make().start()
  transcript('delta', ' ')
  expect(draft).toHaveBeenLastCalledWith('')
  transcript('delta', ' So, how')
  expect(draft).toHaveBeenLastCalledWith('So, how')
  transcript('delta', ' are you?\nHello')
  expect(draft).toHaveBeenLastCalledWith('So, how are you?\nHello')
  capture.stop()
  transcript('completed', ' So, how are you?\nHello!')
  expect(draft).toHaveBeenLastCalledWith('So, how are you?\nHello!')
})
it('caps the draft, stops automatically and retains partial text after the final timeout', async () => {
  await make(5).start()
  transcript('delta', 'hello world')
  expect(draft).toHaveBeenLastCalledWith('hello')
  expect(track.stop).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(3000)
  expect(done).toHaveBeenCalledWith(expect.stringContaining('delayed'))
  transcript('completed', 'lost')
  expect(draft).toHaveBeenCalledTimes(1)
})
it('releases a late microphone grant after Stop during startup, without negotiating', async () => {
  let resolve!: (value: typeof stream) => void
  getUserMedia.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const start = make().start()
  await Promise.resolve()
  capture.stop()
  resolve(stream)
  await start
  expect(track.stop).toHaveBeenCalledOnce()
  expect(connect).not.toHaveBeenCalled()
  expect(done).toHaveBeenCalledOnce()
})
it('recovers from denied permission and a rejected key without keeping a microphone open', async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
  await make().start()
  expect(done).toHaveBeenLastCalledWith(expect.stringContaining('Allow microphone'))
  expect(connect).not.toHaveBeenCalled()
  connect.mockRejectedValueOnce(new Error('Check your API key.'))
  await make().start()
  expect(done).toHaveBeenLastCalledWith('Check your API key.')
  expect(track.stop).toHaveBeenCalledOnce()
})
it('returns an empty draft after silence', async () => {
  await make().start()
  capture.stop()
  transcript('completed', '')
  expect(draft).toHaveBeenLastCalledWith('')
  expect(done).toHaveBeenCalledWith('')
})
it('grants capture to a single requesting window across coaching and dictation', () => {
  const release = holdMic(1)
  try {
    expect(wantsMic(1)).toBe(true)
    expect(wantsMic(2)).toBe(false)
    expect(() => holdMic(2)).toThrow('Stop the current')
  } finally { release() }
  const second = holdMic(2)
  release()
  expect(wantsMic(2)).toBe(true)
  second()
})
it('keeps the transcription model and discards the old Off preference', () => {
  const config = { connection: 'off', model: 'gpt-realtime-whisper' }
  expect(normalizePreferences({ transcription: config }).transcription).toEqual({ model: config.model })
  expect(normalizePreferences({ transcription: { model: 'unknown' } }).transcription).toBeUndefined()
})
