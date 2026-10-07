import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeSession } from '../src/renderer/coach/realtime'
import { COACH_TURN_DETECTION } from '@core/coach/audio'
import { responseCreated, responseDone, toolDone, userDelta, userDone } from './helpers/realtime-events'

const sent: Record<string, unknown>[] = []
let channel: {
  readyState: string
  onmessage: ((event: { data: string }) => void) | null
  onopen: (() => void) | null
  send: (payload: string) => void
  close: () => void
}
let audio: { muted: boolean }
let session: RealtimeSession
let runTool: ReturnType<typeof vi.fn>
const track = { stop: vi.fn(), enabled: true }
let configuration: Record<string, unknown>

function event(payload: Record<string, unknown>): void {
  channel.onmessage?.({ data: JSON.stringify(payload) })
}

function speak(id: string, text: string): void {
  event({ type: 'input_audio_buffer.speech_started', item_id: id })
  event({ type: 'input_audio_buffer.speech_stopped', item_id: id })
  event(userDone(id, text))
}

const requests = () => sent.filter((payload) => payload['type'] === 'response.create')

beforeEach(async () => {
  vi.useFakeTimers()
  sent.length = 0
  track.enabled = true
  runTool = vi.fn().mockResolvedValue({ ok: true, output: '{}', summary: 'Saved notes' })
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [track], getTracks: () => [track] }) }
  })
  vi.stubGlobal('Audio', class {
    muted = false
    autoplay = false
    srcObject = null
    constructor() { audio = this }
    play = vi.fn().mockResolvedValue(undefined)
  })
  vi.stubGlobal('RTCPeerConnection', class {
    ontrack = null
    onconnectionstatechange = null
    connectionState = 'connected'
    addTrack = vi.fn()
    createOffer = vi.fn().mockResolvedValue({ sdp: 'offer' })
    setLocalDescription = vi.fn().mockResolvedValue(undefined)
    setRemoteDescription = vi.fn().mockResolvedValue(undefined)
    close = vi.fn()
    createDataChannel() {
      channel = {
        readyState: 'open', onmessage: null, onopen: null,
        send: (payload) => sent.push(JSON.parse(payload)),
        close: () => { channel.readyState = 'closed' }
      }
      return channel
    }
  })
  vi.stubGlobal('opencourse', {
    connectCoachSession: vi.fn().mockResolvedValue({ answerSdp: 'answer' }),
    saveCoachTurns: vi.fn().mockResolvedValue(undefined),
    endCoachSession: vi.fn().mockResolvedValue(undefined),
    runCoachTool: runTool
  })
  session = new RealtimeSession({
    status: 'ok', sessionId: 'test-session', model: 'gpt-realtime-2.1', voice: 'marin',
    instructions: 'Teach French', tools: [], startedAt: new Date().toISOString()
  }, () => undefined)
  await session.start()
  channel.onopen?.()
  expect(track.enabled).toBe(false)
  configuration = sent[0]
  event({ type: 'session.updated', session: { audio: { input: { turn_detection: COACH_TURN_DETECTION } } } })
  expect(track.enabled).toBe(true)
  sent.length = 0
})

afterEach(async () => {
  await session.stop({ skipWrapUp: true })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WebRTC coach turn handling', () => {
  it('confirms automatic semantic turn handling before enabling microphone input', () => {
    expect(configuration).toEqual({
      type: 'session.update',
      session: { type: 'realtime', audio: { input: {
        turn_detection: COACH_TURN_DETECTION, noise_reduction: { type: 'far_field' }
      } } }
    })
    expect(session.view().status.kind).toBe('live')
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: {
      echoCancellation: { exact: true }, noiseSuppression: true, autoGainControl: true
    } })
  })

  it('keeps the microphone enabled throughout playback and after generation finishes', () => {
    speak('u1', 'Bonjour')
    event(responseCreated('a1'))
    event({ type: 'output_audio_buffer.started', response_id: 'a1' })
    expect(track.enabled).toBe(true)
    event(responseDone('a1'))
    expect(track.enabled).toBe(true)
    expect(session.view().speaking).toBe(true)
    event({ type: 'output_audio_buffer.stopped', response_id: 'a1' })
    expect(track.enabled).toBe(true)
    expect(session.view().speaking).toBe(false)
    expect(sent).toEqual([])
  })

  it('allows spoken interruptions without waiting for transcription or emitting duplicate control events', () => {
    event(responseCreated('a1'))
    event({ type: 'output_audio_buffer.started', response_id: 'a1' })
    event({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
    expect(track.enabled).toBe(true)
    expect(sent).toEqual([])
    // WebRTC handles cancellation and clears unheard output on the server.
    event({ type: 'response.done', response: { id: 'a1', status: 'cancelled', output: [] } })
    event({ type: 'output_audio_buffer.cleared', response_id: 'a1' })
    event({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' })
    event(responseCreated('a2'))
    event(userDone('u1', 'Attends une seconde.'))
    event({ type: 'output_audio_buffer.started', response_id: 'a2' })
    expect(track.enabled).toBe(true)
    expect(audio.muted).toBe(false)
    expect(sent).toEqual([])
    expect(session.view().activity).toEqual([])
    expect(session.view().turns.some((turn) => turn.text === 'Attends une seconde.')).toBe(true)
  })

  it('treats provisional and empty transcription as display data rather than response triggers', () => {
    event(responseCreated('a1'))
    event(userDelta('u1', 'a provisional guess'))
    event(userDone('u1', ''))
    event(userDone('empty', ''))
    expect(sent).toEqual([])
    expect(session.view().partial).toBeNull()
    expect(session.view().turns).toEqual([])
  })

  it('ignores a stale playback completion while a new response is playing', () => {
    event({ type: 'output_audio_buffer.started', response_id: 'old' })
    event({ type: 'output_audio_buffer.started', response_id: 'new' })
    event({ type: 'output_audio_buffer.stopped', response_id: 'old' })
    expect(session.view().speaking).toBe(true)
    expect(track.enabled).toBe(true)
  })

  it('keeps an optional stop-speaking control while leaving the microphone open', () => {
    event(responseCreated('a1'))
    event({ type: 'output_audio_buffer.started', response_id: 'a1' })
    session.interrupt()
    expect(sent).toEqual([
      { type: 'response.cancel', response_id: 'a1' }, { type: 'output_audio_buffer.clear' }
    ])
    expect(audio.muted).toBe(true)
    expect(track.enabled).toBe(true)
    event(responseDone('a1'))
    event(responseCreated('a2'))
    event({ type: 'output_audio_buffer.started', response_id: 'a2' })
    expect(audio.muted).toBe(false)
    expect(track.enabled).toBe(true)
  })

  it('does not replay delayed audio from a manually stopped response', () => {
    event(responseCreated('a1'))
    session.interrupt()
    event({ type: 'output_audio_buffer.started', response_id: 'a1' })
    expect(audio.muted).toBe(true)
    expect(session.view().speaking).toBe(false)
    expect(sent.at(-1)).toEqual({ type: 'output_audio_buffer.clear' })
    expect(track.enabled).toBe(true)
  })

  it('shows failed and incomplete responses instead of silently stopping text', () => {
    for (const status of ['failed', 'incomplete']) {
      event(responseCreated(status))
      event({ type: 'response.done', response: { id: status, status, status_details: { reason: 'max_output_tokens' }, output: [] } })
    }
    expect(session.view().activity).toHaveLength(2)
    expect(session.view().activity.every((entry) => !entry.ok && entry.text.includes('max_output_tokens'))).toBe(true)
    expect(session.view().responding).toBe(false)
  })

  it('closes a connection that never confirms the requested turn policy', async () => {
    await session.stop({ skipWrapUp: true })
    session = new RealtimeSession({
      status: 'ok', sessionId: 'unconfigured', model: 'gpt-realtime-2.1', voice: 'marin',
      instructions: 'Teach French', tools: [], startedAt: new Date().toISOString()
    }, () => undefined)
    await session.start()
    channel.onopen?.()
    event({ type: 'session.updated', session: { audio: { input: { turn_detection: { type: 'server_vad', create_response: false } } } } })
    expect(track.enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(session.view().status.kind).toBe('error')
    expect(channel.readyState).toBe('closed')
  })

  it('does not reopen the microphone after the session ends', async () => {
    event({ type: 'output_audio_buffer.started', response_id: 'a1' })
    await session.stop({ skipWrapUp: true })
    event({ type: 'output_audio_buffer.stopped', response_id: 'a1' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(track.enabled).toBe(false)
  })

  it('finishes interrupted tool writes without answering the previous statement again', async () => {
    let finish!: (value: { ok: boolean; output: string; summary: string }) => void
    runTool.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    event(responseCreated('a1'))
    event(toolDone('write1', 'write_file', '{}'))
    speak('u2', 'Une autre question')
    event(responseDone('a1'))
    event(responseCreated('a2'))
    finish({ ok: true, output: '{}', summary: 'Saved' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.filter((payload) => payload['type'] === 'conversation.item.create')).toHaveLength(1)
    expect(requests()).toHaveLength(0)
  })

  it('disables automatic replies during wrap-up and keeps tool continuations silent', async () => {
    event({ type: 'input_audio_buffer.speech_started', item_id: 'unfinished' })
    const stopping = session.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(audio.muted).toBe(true)
    expect(track.enabled).toBe(false)
    expect(sent[0]).toEqual({ type: 'session.update', session: { type: 'realtime', audio: { input: {
      turn_detection: { ...COACH_TURN_DETECTION, create_response: false, interrupt_response: false }
    } } } })
    expect(requests()).toEqual([{ type: 'response.create', response: { output_modalities: ['text'] } }])
    event(responseCreated('wrapup'))
    event(toolDone('save', 'write_file', '{}'))
    event(responseDone('wrapup', 1))
    await vi.advanceTimersByTimeAsync(0)
    await stopping
    expect(requests()).toHaveLength(2)
    for (const request of requests()) expect(request['response']).toEqual({ output_modalities: ['text'] })
    expect(session.view().status.kind).toBe('ended')
  })
})
