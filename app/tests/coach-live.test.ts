/** Parity contract: continuous microphone, interruptions, simultaneous captions,
 * tools during speech, memory writes, bounded two-pass wrap-up, Stop now, cap,
 * startup races, background ownership, persistence, and graceful finalization.
 * Background/files/security/history coverage also lives in coach-{background,files,session,db,pipeline}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSession, MAX_SESSION_MS } from '../src/renderer/coach/live'
import { liveTranscript } from '../src/core/coach/live-transcript'
import { PlaybackGate } from '../src/core/coach/playback'
import { LiveDelegation } from '../src/core/coach/live-delegation'
import { buildLiveInstructions, buildBackendInstructions } from '../src/core/coach/prompt'
import { filterLiveModels } from '../src/core/coach/models'

const sent: any[] = []
let channel: any, audio: any, session: LiveSession, api: any, pc: any
const track = { stop: vi.fn(), enabled: true }
const config = { status: 'ok' as const, sessionId: 'session', model: 'gpt-live-1', voice: 'marin', instructions: 'Teach French', backendModel: 'gpt-6-luna', backendInstructions: 'Remember progress', tools: [], startedAt: '2026-10-16T10:00:00Z' }
let eventId = 0
function event(value: any): void { channel.onmessage?.({data: JSON.stringify({event_id: `e${++eventId}`, ...value})}) }
function backend(value: any): void { event({type: 'response.event', delegation_id: 'd1', event: value}) }
function response(id: string): void { backend({type: 'response.created', response: {id}}) }
function done(id: string): void { backend({type: 'response.completed', response: {id, status: 'completed', output: []}}) }
function tool(id: string, name = 'write_file'): void { backend({type: 'response.output_item.done', item: {type: 'function_call', call_id: id, name, arguments: '{}'}}) }
async function tick(ms = 30): Promise<void> { await vi.advanceTimersByTimeAsync(ms) }
async function connect(): Promise<void> {
  const starting = session.start()
  await tick()
  event({type: 'session.started'})
  await tick()
  await starting
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0; eventId = 0; track.enabled = true; track.stop.mockClear()
  vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: vi.fn(async () => ({getTracks: () => [track], getAudioTracks: () => [track]}))}})
  vi.stubGlobal('Audio', class { muted = false; autoplay = false; srcObject = null; constructor() {audio = this} play = vi.fn(async () => {}) })
  vi.stubGlobal('AudioContext', class {
    resume = vi.fn(async () => {}); close = vi.fn(async () => {})
    createAnalyser = () => ({fftSize: 512, getFloatTimeDomainData: (a: Float32Array) => a.fill(0)})
    createMediaStreamSource = () => ({connect: vi.fn()})
  })
  vi.stubGlobal('RTCPeerConnection', class {
    iceGatheringState = 'complete'; connectionState = 'connected'; localDescription = {sdp: 'v=0 offer'}
    ontrack = null; onconnectionstatechange = null
    constructor() {pc = this}
    createOffer = vi.fn(async () => ({sdp: 'v=0 offer'})); setLocalDescription = vi.fn(async () => {}); setRemoteDescription = vi.fn(async () => {}); addTrack = vi.fn(); close = vi.fn()
    createDataChannel() {
      channel = {readyState: 'open', onmessage: null, onclose: null, send: (raw: string) => {
        const value = JSON.parse(raw); sent.push(value)
        if (value.type === 'session.close') event({type: 'session.closed', reason: 'close_requested', usage: {seconds: 12}})
        if (value.type === 'session.update') {
          // Live requires the delegation discriminator even for sparse updates.
          // https://developers.openai.com/api/reference/resources/live/fork-websocket#session.update
          if (value.session.delegation.type !== 'responses') {
            event({type: 'error', error: {code: 'missing_required_parameter', type: 'invalid_request_error', client_event_id: value.event_id}})
          } else event({type: 'session.updated', client_event_id: value.event_id})
        }
      }, close: vi.fn()}
      return channel
    }
  })
  api = {
    connectCoachSession: vi.fn(async () => ({answerSdp: 'v=0 answer', remoteSessionId: 'live_remote'})),
    saveCoachFragments: vi.fn(async () => {}), endCoachSession: vi.fn(async () => {}),
    runCoachTool: vi.fn(async () => ({ok: true, output: '{}', summary: 'Saved notes'})),
    reportCoachResponse: vi.fn(async () => {}), onCoachShutdown: vi.fn(() => vi.fn())
  }
  vi.stubGlobal('opencourse', api)
  session = new LiveSession(config, vi.fn())
})
afterEach(async () => { const stopping = session.stop({skipWrapUp: true}); await tick(6000); await stopping; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Live connection and conversation parity', () => {
  it('uses one connection and enables the microphone only after session.started', async () => {
    const starting = session.start(); await tick()
    expect(track.enabled).toBe(false)
    expect(api.connectCoachSession).toHaveBeenCalledOnce()
    event({type: 'session.started'}); await tick(); await starting
    expect(track.enabled).toBe(true)
    expect(session.view().status.kind).toBe('live')
    expect(sent).toEqual([])
    await session.start()
    expect(api.connectCoachSession).toHaveBeenCalledOnce()
  })
  it('does not create a remote session after microphone refusal and releases the local session', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('Denied'), {name: 'NotAllowedError'}))
    await session.start()
    expect(api.connectCoachSession).not.toHaveBeenCalled()
    expect(api.endCoachSession).toHaveBeenCalled()
    expect(session.view().status.kind).toBe('mic-denied')
  })
  it('waits for ICE and does not create a remote session after Stop now', async () => {
    const start = session.start(); await tick()
    // This session has reached HTTP creation; exercise the late-answer path.
    expect(api.connectCoachSession).toHaveBeenCalledOnce()
    const stop = session.stop({skipWrapUp: true})
    event({type: 'session.started'}); await tick(); await start; await stop
    expect(track.enabled).toBe(false)
    expect(sent.some(e => e.type === 'session.close')).toBe(true)
    expect(pc.close).toHaveBeenCalled()
  })
  it('fails a handshake that never starts and never retries creation', async () => {
    const start = session.start(); await tick(10_100); await start
    expect(session.view().status.kind).toBe('error')
    expect(api.connectCoachSession).toHaveBeenCalledOnce()
    expect(pc.close).toHaveBeenCalled()
  })
  it('keeps the microphone running through speech interruption and backend work', async () => {
    await connect(); response('r1'); tool('call1'); session.interrupt()
    expect(track.enabled).toBe(true); expect(audio.muted).toBe(true)
    expect(sent.at(-1).type).toBe('session.instructions.append')
    done('r1'); await tick()
    expect(api.runCoachTool).toHaveBeenCalledOnce()
    expect(audio.muted).toBe(true)
    expect(sent.some(e => ['response.cancel', 'output_audio_buffer.clear'].includes(e.type))).toBe(false)
  })
  it('collects overlapping and late captions without backend text or duplicate events', async () => {
    await connect()
    event({type: 'session.input_transcript.delta', event_id: 'u2', delta: ' très bien', start_ms: 900, end_ms: 1200})
    event({type: 'session.output_transcript.delta', delta: 'Oui', start_ms: 500, end_ms: 700})
    event({type: 'session.input_transcript.delta', event_id: 'u1', delta: 'Je vais', start_ms: 100, end_ms: 400})
    event({type: 'session.input_transcript.delta', event_id: 'u1', delta: 'Je vais', start_ms: 100, end_ms: 400})
    backend({type: 'response.output_text.delta', delta: 'PRIVATE BACKEND'})
    expect(session.view().turns.map(t => t.text)).toEqual(['Je vais très bien', 'Oui'])
    await tick(3100)
    expect(api.saveCoachFragments.mock.calls[0][1]).toHaveLength(3)
  })
  it('retains fragments after persistence failure and flushes them on disconnect', async () => {
    await connect(); api.saveCoachFragments.mockRejectedValueOnce(new Error('busy'))
    event({type: 'session.input_transcript.delta', delta: 'Unfinished', start_ms: 0, end_ms: 40})
    await tick(3100)
    pc.connectionState = 'failed'; pc.onconnectionstatechange(); await tick(5100)
    expect(api.saveCoachFragments.mock.calls.at(-1)[1][0].text).toBe('Unfinished')
    expect(api.endCoachSession.mock.calls.at(-1)[1].status).toBe('failed')
  })
  it('closes on asynchronous backend validation failure instead of pretending coaching works', async () => {
    await connect(); event({type: 'error', error: {code: 'responses_validation_failed', message: 'SECRET'}}); await tick()
    expect(session.view().status.kind).toBe('error')
    expect(JSON.stringify(session.view())).not.toContain('SECRET')
    expect(api.endCoachSession).toHaveBeenCalled()
  })
})

describe('silent finish and finalization', () => {
  it('finishes a note-writing tool chain silently and records confirmed usage', async () => {
    await connect(); const stop = session.stop(); await tick()
    expect(track.stop).toHaveBeenCalled(); expect(audio.muted).toBe(true)
    response('wrap'); tool('save'); done('wrap'); await tick()
    response('continuation'); done('continuation'); await tick(); await stop
    expect(api.runCoachTool).toHaveBeenCalledOnce()
    expect(api.endCoachSession.mock.calls.at(-1)[1]).toMatchObject({status: 'ended', metadata: {finalization: 'confirmed', voiceSeconds: 12}})
    expect(session.view().turns).toEqual([])
  })
  it('forces the second save when the first attempt only reads, then Stop now cancels waiting', async () => {
    await connect(); const stop = session.stop(); await tick()
    response('read'); tool('read1', 'read_file'); done('read'); await tick()
    response('read-result'); done('read-result'); await tick()
    expect(sent.some(e => e.type === 'session.update' && e.session.delegation.responses.tool_choice.name === 'write_file')).toBe(true)
    const now = session.stop({skipWrapUp: true}); await tick(); await now; await stop
    expect(sent.some(e => e.type === 'session.close')).toBe(true)
  })
  it('bounds stalled backend draining and reports that nothing was saved', async () => {
    await connect(); response('stalled'); const stop = session.stop(); await tick(10_100); await stop
    expect(api.endCoachSession.mock.calls.at(-1)[1].error).toContain('could not save')
  })
  it('does not treat missing finalization as confirmed', async () => {
    await connect(); channel.send = (raw: string) => sent.push(JSON.parse(raw))
    const stop = session.stop({skipWrapUp: true}); await tick(5100); await stop
    expect(api.endCoachSession.mock.calls.at(-1)[1]).toMatchObject({metadata: {finalization: 'unconfirmed'}})
  })
  it('automatically wraps up at 45 minutes and releases tracks', async () => {
    await connect(); vi.advanceTimersByTime(MAX_SESSION_MS); await tick()
    expect(track.stop).toHaveBeenCalled(); expect(audio.muted).toBe(true)
    expect(session.view().status.kind).toBe('wrapping-up')
  })
})

describe('pure Live state', () => {
  it('requires new learner audio and a silence boundary before unmuting', () => {
    const gate = new PlaybackGate(); gate.interrupt()
    gate.sample(0, 0, 0); gate.sample(0, 0, 1000); gate.sample(0, .1, 1100)
    expect(gate.muted).toBe(true)
    gate.sample(.1, .1, 1200); gate.sample(0, 0, 1300); gate.sample(0, 0, 1650)
    expect(gate.muted).toBe(true)
    gate.sample(0, .1, 1700); expect(gate.muted).toBe(false)
  })
  it('preserves repeated words and groups each speaker independently', () => {
    const f = (eventId: string, text: string, startMs: number, role: 'user' | 'assistant' = 'user') => ({eventId, text, startMs, endMs: startMs + 100, role})
    expect(liveTranscript([f('1','yes',0), f('2','Yes',200,'assistant'),f('3',' yes',500),f('4',' again',2500)], config.startedAt).map(t => t.text)).toEqual(['yes yes','Yes',' again'])
  })
  it('keeps the complete custom brief in both prompts and excludes transcription models', () => {
    const project = {name: 'French', instructions: 'CUSTOM '.repeat(1100), allowDelete: false}
    expect(buildLiveInstructions(project)).toContain(project.instructions.trim())
    expect(buildBackendInstructions(project, [])).toContain(project.instructions.trim())
    expect(filterLiveModels(['gpt-realtime','gpt-live-transcribe','gpt-live-1'])).toEqual([{id:'gpt-live-1',label:'gpt-live-1'}])
  })
  it('executes duplicate function events once and continues only after all results', async () => {
    const send = vi.fn(), run = vi.fn(async () => ({ok:true,output:'{}',summary:'saved'}))
    const d = new LiveDelegation({send, tool:run, note:vi.fn(), changed:vi.fn()})
    const emit = (event: any) => d.handle({delegation_id:'d',event})
    emit({type:'response.created',response:{id:'r'}})
    const call = {type:'response.output_item.done',item:{type:'function_call',call_id:'c',name:'write_file',arguments:'{}'}}
    emit(call); emit(call); emit({type:'response.completed',response:{id:'r',status:'completed',output:[]}})
    await tick()
    expect(run).toHaveBeenCalledOnce()
    expect(send.mock.calls.map(c => c[0].type)).toEqual(['response.item.create','response.create'])
    emit({type:'response.completed',response:{id:'r',status:'completed'}})
    expect(send).toHaveBeenCalledTimes(2)
    expect(d.busy).toBe(true) // continuation has been requested, not started yet
  })
})


describe('Live race and failure regressions', () => {
  it('waits for the complete ICE offer before spending a remote session', async () => {
    const start = session.start()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    pc.iceGatheringState = 'gathering'
    await tick(200)
    expect(api.connectCoachSession).not.toHaveBeenCalled()
    pc.iceGatheringState = 'complete'
    await tick()
    expect(api.connectCoachSession).toHaveBeenCalledOnce()
    event({type: 'session.started'}); await tick(); await start
  })
  it('does not create a billable session for an empty microphone stream', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue({getTracks: () => [], getAudioTracks: () => []})
    await session.start()
    expect(api.connectCoachSession).not.toHaveBeenCalled()
    expect(session.view().status.kind).toBe('error')
  })
  it('closes a genuinely late HTTP connection after Stop now', async () => {
    let resolve!: (value: any) => void
    api.connectCoachSession.mockImplementation(() => new Promise(r => {resolve = r}))
    const starting = session.start(); await tick()
    const stopping = session.stop({skipWrapUp: true})
    expect(track.stop).toHaveBeenCalled(); expect(audio.muted).toBe(true)
    resolve({answerSdp: 'v=0 late', remoteSessionId: 'live_late'}); await tick()
    event({type: 'session.started'}); await tick(); await starting; await stopping
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({type: 'answer', sdp: 'v=0 late'})
    expect(sent.filter(e => e.type === 'session.close')).toHaveLength(1)
    expect(track.enabled).toBe(false)
  })
  it('finishes a forced second write and resets tool choice before continuing', async () => {
    await connect(); const stopping = session.stop(); await tick()
    response('first'); done('first'); await tick()
    expect(sent.filter(e => e.type === 'response.create')).toHaveLength(2)
    expect(sent.find(e => e.type === 'session.update').session.delegation).toEqual({
      type: 'responses', responses: {tool_choice: {type: 'function', name: 'write_file'}}
    })
    response('forced'); tool('write_second'); done('forced'); await tick()
    const reset = sent.findIndex(e => e.type === 'session.update' && e.session.delegation.responses.tool_choice === 'auto')
    expect(reset).toBeGreaterThan(0)
    expect(sent.slice(reset + 1).some(e => e.type === 'response.create')).toBe(true)
    response('saved'); done('saved'); await tick(); await stopping
    expect(api.endCoachSession.mock.calls.at(-1)[1].error).toBeUndefined()
    expect(session.view().activity.filter(a => !a.ok)).toEqual([])
  })
  it('reports request error codes and correlation without copying provider messages', async () => {
    await connect()
    event({type: 'error', error: {
      code: 'missing_required_parameter', type: 'invalid_request_error', client_event_id: 'coach_7',
      message: 'PRIVATE PROMPT CONTENT', param: 'PRIVATE PARAMETER'
    }})
    expect(api.reportCoachResponse).toHaveBeenCalledWith('session', {
      event: 'session.error', clientEventId: 'coach_7', errorCode: 'missing_required_parameter',
      errorType: 'invalid_request_error', wrappingUp: false, pendingTools: 0
    })
    expect(JSON.stringify(api.reportCoachResponse.mock.calls)).not.toContain('PRIVATE')
    expect(JSON.stringify(session.view())).not.toContain('PRIVATE')
  })
  it('keeps late speech from before Finish but excludes new assistant speech during wrap-up', async () => {
    await connect(); await tick(2000)
    const stopping = session.stop(); await tick()
    event({type: 'session.output_transcript.delta', delta: 'Earlier speech', start_ms: 500, end_ms: 1500})
    event({type: 'session.output_transcript.delta', delta: 'Internal wrap-up', start_ms: 3000, end_ms: 3500})
    expect(session.view().turns.map(t => t.text)).toEqual(['Earlier speech'])
    const now = session.stop({skipWrapUp: true}); await tick(); await stopping; await now
  })
  it('bounds a note-saving response that never starts', async () => {
    await connect(); const stopping = session.stop(); await tick(20_100); await stopping
    expect(api.endCoachSession.mock.calls.at(-1)[1].error).toContain('could not save')
  })
  it('surfaces failed backend work once without putting its contents in transcripts', async () => {
    await connect(); response('bad')
    const failed = {type: 'response.failed', response: {id: 'bad', status: 'failed', error: {message: 'private'}}}
    backend(failed); backend(failed)
    expect(session.view().activity.filter(a => !a.ok)).toHaveLength(1)
    expect(session.view().responding).toBe(false)
    expect(session.view().turns).toEqual([])
    expect(JSON.stringify(session.view())).not.toContain('private')
  })
  it('clears rejected response requests rather than staying busy forever', () => {
    const d = new LiveDelegation({send: () => 'request1', tool: vi.fn(), note: vi.fn(), changed: vi.fn()})
    d.request(); expect(d.busy).toBe(true)
    d.reject('request1'); expect(d.busy).toBe(false)
  })
})


it('keeps final backend usage while closing, without starting more work', async () => {
  await connect(); response('closing')
  channel.send = (raw: string) => sent.push(JSON.parse(raw))
  const stopping = session.stop({skipWrapUp: true}); await tick()
  backend({type: 'response.cancelled', response: {id: 'closing', status: 'cancelled', usage: {input_tokens: 5, output_tokens: 2, total_tokens: 7}}})
  event({type: 'session.closed', reason: 'close_requested', usage: {seconds: 3}})
  await tick(); await stopping
  expect(api.endCoachSession.mock.calls.at(-1)[1].metadata.backendUsage.totalTokens).toBe(7)
  expect(api.runCoachTool).not.toHaveBeenCalled()
})
