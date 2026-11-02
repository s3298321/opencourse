/**
 * Starting and ending a live session, with OpenAI and the microphone stubbed.
 *
 * The behaviour worth pinning here is all about failure: a refused microphone
 * must not have cost an API call, an ambiguous creation must never be repeated, and a session must never be left claiming to be live - whether the
 * renderer went away, the app quit, or the machine was pulled out of the wall.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-coachsession-'))
let dataDir = join(root, 'data')

let micGranted = true
let micRequest: Promise<boolean> | undefined
let quitHandler: (() => void) | null = null

interface Call {
  url: string
  body: string
  auth: string
}
let calls: Call[] = []
/** Per-path queue of canned responses; the default is a happy one. */
let responses: Record<string, { status: number; body: string }[]> = {}

function respond(url: string): { status: number; body: string } {
  for (const [fragment, queue] of Object.entries(responses)) {
    if (url.includes(fragment) && queue.length) return queue.shift() as { status: number; body: string }
  }
  if (url.includes('/live/sessions')) return { status: 201, body: JSON.stringify({ session: { id: 'live_remote' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer\r\n' } }) }
  return { status: 200, body: JSON.stringify({ data: [{ id: 'gpt-live-1' }] }) }
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false,
    on: (event: string, handler: () => void) => {
      if (event === 'before-quit') quitHandler = handler
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  },
  systemPreferences: {
    askForMediaAccess: () => micRequest ?? Promise.resolve(micGranted),
    getMediaAccessStatus: () => (micGranted ? 'granted' : 'denied')
  },
  net: {
    fetch: (url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ url, body: init.body ?? '', auth: init.headers?.['Authorization'] ?? '' })
      const { status, body } = respond(url)
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: () => Promise.resolve(body)
      })
    }
  }
}))

const { createUser, deleteUser, listUsers, requireUser, switchUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { selectSessionRow, selectSessions, selectToolCalls, selectSessionSummary } = await import('../src/main/coachdb')
const { createProject, updateProject, deleteProject } = await import('../src/main/coach')
const { previewCoachVoice } = await import('../src/main/coach-voice-preview')
const { setDefaultCoachPrompts, getDefaultCoachPrompts } = await import('../src/main/preferences')
const { getCoachAllowDelete, setCoachAllowDelete, setDefaultCoachVoice, setDefaultCoachBackendModel, setDefaultCoachBackendReasoning } = await import('../src/main/preferences')
const { isCoachProjectBusy } = await import('../src/main/coach-activity')
const { setKey } = await import('../src/main/coachkey')
const { log } = await import('../src/main/log')
const { wantsMic } = await import('../src/main/mic')
const {
  executeCoachTool,
  reportCoachResponse,
  connectSession,
  countToolCall,
  endAllSessions,
  endForSender,
  endSession,
  liveSessionCount,
  startSession,
  toolCaps
} = await import('../src/main/coachsession')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const GOOD = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
const accept = async (): Promise<{ ok: true }> => ({ ok: true })
const sender = (id: number): { id: number; once: () => void; on: () => void } => ({
  id,
  once: () => undefined,
  on: () => undefined
})

let n = 0
let projectId = ''

beforeEach(async () => {
  endAllSessions()
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
  micGranted = true
  micRequest = undefined
  calls = []
  responses = {}
  createUser('Ada')
  projectId = createProject({ name: 'French' }).id
  await setKey(GOOD, accept)
  calls = []
})

/** The WebContents the session binds to; only `id` and the listeners matter here. */
const start = (id = 1): ReturnType<typeof startSession> => startSession(sender(id) as any, projectId)

describe('starting a session', () => {
  it('uses a coach’s saved first and following prompts despite later default edits', async () => {
    const prompts = { ...getDefaultCoachPrompts(), shared: 'SHARED_SNAPSHOT', voice: 'VOICE_SNAPSHOT', backend: 'BACKEND_SNAPSHOT', firstConversation: 'FIRST_SNAPSHOT', followingConversations: 'FOLLOWING_SNAPSHOT' }
    setDefaultCoachPrompts(prompts)
    projectId = createProject({ name: 'Custom coach' }).id
    setDefaultCoachPrompts({ ...prompts, shared: 'CHANGED_SHARED', firstConversation: 'CHANGED_FIRST', followingConversations: 'CHANGED_FOLLOWING' })
    const first = await start()
    if (first.status !== 'ok') throw new Error('not started')
    expect(first.instructions).toContain('SHARED_SNAPSHOT')
    expect(first.instructions).toContain('VOICE_SNAPSHOT')
    expect(first.instructions).toContain('FIRST_SNAPSHOT')
    expect(first.instructions).not.toContain('FOLLOWING_SNAPSHOT')
    expect(first.backendInstructions).toContain('BACKEND_SNAPSHOT')
    expect(first.backendInstructions).toContain('FIRST_SNAPSHOT')
    expect(first.backendInstructions).not.toContain('VOICE_SNAPSHOT')
    endSession(first.sessionId, { status: 'ended', turns: [] })
    const following = await start()
    if (following.status !== 'ok') throw new Error('not started')
    expect(following.instructions).toContain('FOLLOWING_SNAPSHOT')
    expect(following.instructions).not.toContain('FIRST_SNAPSHOT')
    expect(following.backendInstructions).toContain('FOLLOWING_SNAPSHOT')
    expect(following.instructions + following.backendInstructions).not.toContain('CHANGED_')
    expect(selectSessionRow(first.sessionId)?.instructions).toContain('FIRST_SNAPSHOT')
  })
  it('previews a voice without coach history, tools, microphone permission or persisted sessions', async () => {
    micGranted = false
    expect(await previewCoachVoice(sender(1) as any, 'brise', 'v=0 offer')).toEqual({ answerSdp: 'v=0\r\nanswer\r\n' })
    const request = JSON.parse(calls.at(-1)!.body)
    expect(request.session).toMatchObject({ model: 'gpt-live-1', store: false, audio: { output: { voice: 'brise' } }, delegation: { type: 'client' } })
    expect(request.session.input[0].role).toBe('developer')
    expect(request.session.instructions).toContain('voice preview')
    expect(selectSessions(projectId)).toHaveLength(0)
    expect(wantsMic()).toBe(false)
    expect(liveSessionCount()).toBe(0)
  })
  it('rejects unsupported preview voices, invalid SDP and missing keys before any request', async () => {
    await expect(previewCoachVoice(sender(1) as any, 'unknown', 'v=0 offer')).rejects.toThrow('supported coach voice')
    await expect(previewCoachVoice(sender(1) as any, 'marin', 'bad')).rejects.toThrow('Invalid preview')
    const { clearKey } = await import('../src/main/coachkey')
    clearKey()
    await expect(previewCoachVoice(sender(1) as any, 'marin', 'v=0 offer')).rejects.toThrow('API key')
    expect(calls).toHaveLength(0)
  })
  it('refuses without a key, before asking for the microphone', async () => {
    const { clearKey } = await import('../src/main/coachkey')
    clearKey()

    expect(await start()).toEqual({ status: 'no-key' })
    expect(calls).toHaveLength(0)
    expect(selectSessions(projectId)).toHaveLength(0)
  })

  it('refuses a denied microphone without spending an API call on it', async () => {
    micGranted = false

    expect(await start()).toEqual({ status: 'mic-denied' })
    expect(calls).toHaveLength(0)
    expect(selectSessions(projectId)).toHaveLength(0)
    // And the permission handler must not be left holding the door open.
    expect(wantsMic()).toBe(false)
  })

  it('opens the microphone only while a session is running', async () => {
    expect(wantsMic()).toBe(false)
    const started = await start()
    expect(wantsMic()).toBe(true)

    if (started.status !== 'ok') throw new Error(started.status)
    endSession(started.sessionId, { status: 'ended' })
    expect(wantsMic()).toBe(false)
  })

  it('records the session as live, with the model and brief it actually used', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    const row = selectSessionRow(started.sessionId)
    expect(row?.status).toBe('live')
    expect(row?.project_id).toBe(projectId)
    // The brief is snapshotted, so changing it later cannot rewrite history.
    expect(row?.instructions).toBe(started.instructions)
    expect(started.model).toBe('gpt-live-1')
  })

  it('tells the coach what is in its workspace before a word is said', async () => {
    const { writeWorkspaceFile } = await import('../src/main/coachfiles')
    writeWorkspaceFile(projectId, 'learned.md', '- le chien')

    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    expect(started.instructions).toContain('learned.md')
  })

  it('never hands the renderer a credential', async () => {
    const started = await start()
    const serialised = JSON.stringify(started)
    expect(serialised).not.toContain('ek_')
    expect(serialised).not.toContain('sk-')
  })

  it('creates a Live session with separate prompts and sequential tools after microphone setup', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    expect(calls).toHaveLength(0)
    await connectSession(started.sessionId, 'v=0\r\noffer')
    const request = calls[0]
    const body = JSON.parse(request.body)
    expect(request.url).toContain('/live/sessions')
    expect(request.auth).toBe(`Bearer ${GOOD}`)
    expect(body.session).toMatchObject({ model: 'gpt-live-1', store: false, audio: { output: { voice: 'marin' } }, delegation: { type: 'responses', responses: { model: 'gpt-6-luna', parallel_tool_calls: false } } })
    expect(body.session.delegation.responses.tools.map((t: {name: string}) => t.name)).toContain('write_file')
    expect(body.session.instructions).toContain('Delegation policy')
    expect(body.session.delegation.responses.instructions).toContain('ASCII')
    expect(body.session.audio.input).toBeUndefined()
  })

  it('withholds the delete tool until the global setting allows it', async () => {
    const off = await start()
    expect(off.status === 'ok' && (off.tools as { name: string }[]).map((t) => t.name)).not.toContain('delete_file')

    endAllSessions()
    updateProject(projectId, { allowDelete: true })
    const legacy = await start(2)
    expect(legacy.status === 'ok' && (legacy.tools as { name: string }[]).map(t => t.name)).not.toContain('delete_file')
    endAllSessions()
    setCoachAllowDelete(true)
    const on = await start(3)
    expect(on.status === 'ok' && (on.tools as { name: string }[]).map((t) => t.name)).toContain('delete_file')
  })

  it('applies permission to all coaches, persists per user and revokes live deletion immediately', async () => {
    const owner = requireUser()
    setCoachAllowDelete(true)
    const second = createProject({name: 'Chess'})
    const started = await startSession(sender(7) as any, second.id)
    if (started.status !== 'ok') throw new Error(started.status)
    expect((started.tools as {name: string}[]).map(tool => tool.name)).toContain('delete_file')
    await executeCoachTool(started.sessionId, 7, 'write_file', JSON.stringify({path: 'notes.md', content: 'Keep'}))
    setCoachAllowDelete(false)
    expect((await executeCoachTool(started.sessionId, 7, 'delete_file', JSON.stringify({path: 'notes.md'}))).ok).toBe(false)
    endAllSessions()
    setCoachAllowDelete(true)
    createUser('Grace')
    expect(getCoachAllowDelete()).toBe(false)
    switchUser(owner)
    expect(getCoachAllowDelete()).toBe(true)
  })

  it('reports an OpenAI refusal without creating a second billable session', async () => {
    responses = { '/live/sessions': [{ status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) }] }
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    await expect(connectSession(started.sessionId, 'v=0')).rejects.toThrow('HTTP 429')
    await expect(connectSession(started.sessionId, 'v=0')).rejects.toThrow('HTTP 429')
    expect(calls).toHaveLength(1)
    endSession(started.sessionId, {status: 'failed'})
    expect(wantsMic()).toBe(false)
  })
})

describe('project deletion while connecting or running', () => {
  it('refuses deletion until the live session ends', async () => {
    const result = await start()
    expect(isCoachProjectBusy(projectId)).toBe(true)
    expect(() => deleteProject(projectId)).toThrow(/Finish/)
    if (result.status === 'ok') endSession(result.sessionId, { status: 'ended' })
    expect(isCoachProjectBusy(projectId)).toBe(false)
    expect(() => deleteProject(projectId)).not.toThrow()
  })
  it('refuses deletion while permission is being requested', async () => {
    let grant!: (value: boolean) => void
    micRequest = new Promise(resolve => { grant = resolve })
    const connecting = start()
    expect(await start(8)).toMatchObject({ status: 'failed' })
    expect(() => deleteProject(projectId)).toThrow(/Finish/)
    grant(false)
    await connecting
    expect(() => deleteProject(projectId)).not.toThrow()
  })
  it('holds pending tools after the session ends', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    const tools = await import('../src/main/coachtools')
    let finish!: (value: {ok: boolean; output: string; summary: string}) => void
    const run = vi.spyOn(tools, 'runCoachTool').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    try {
      const pending = executeCoachTool(started.sessionId, 1, 'web_search', '{}')
      await Promise.resolve()
      endSession(started.sessionId, {status: 'ended'})
      expect(() => deleteProject(projectId)).toThrow(/Finish/)
      finish({ok: true, output: '{}', summary: 'Search complete'})
      await pending
      expect(() => deleteProject(projectId)).not.toThrow()
    } finally { run.mockRestore() }
  })
  it('releases the project after a refused microphone', async () => {
    micGranted = false
    await start()
    expect(isCoachProjectBusy(projectId)).toBe(false)
  })
})

describe('connecting', () => {
  it('coalesces duplicate requests and returns no credentials', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    const results = await Promise.all([connectSession(started.sessionId, 'v=0 offer'), connectSession(started.sessionId, 'v=0 offer')])
    expect(calls).toHaveLength(1)
    expect(results[0]).toEqual({answerSdp: 'v=0\r\nanswer\r\n', remoteSessionId: 'live_remote'})
    expect(results[1]).toEqual(results[0])
  })
  it('rejects another window and unknown sessions', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    await expect(connectSession(started.sessionId, 'v=0', 999)).rejects.toThrow('another window')
    await expect(connectSession('cs_000000000000', 'v=0')).rejects.toThrow('not running')
    expect(calls).toHaveLength(0)
  })
})

describe('tool caps', () => {
  it('counts calls and searches separately', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    expect(toolCaps(started.sessionId)).toMatchObject({ toolCalls: 0, searches: 0 })
    countToolCall(started.sessionId, 'write_file')
    countToolCall(started.sessionId, 'web_search')

    expect(toolCaps(started.sessionId)).toMatchObject({ toolCalls: 2, searches: 1 })
  })

  it('exposes limits that are actually finite', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    const caps = toolCaps(started.sessionId)
    expect(caps.maxToolCalls).toBeGreaterThan(0)
    expect(caps.maxSearches).toBeGreaterThan(0)
    expect(caps.maxSearches).toBeLessThanOrEqual(caps.maxToolCalls)
  })
})

describe('a session that does not end by being stopped', () => {
  it('dies with the renderer that asked for it', async () => {
    const started = await start(7)
    if (started.status !== 'ok') throw new Error(started.status)
    expect(liveSessionCount()).toBe(1)

    endForSender(7, 'the window closed')

    expect(liveSessionCount()).toBe(0)
    const row = selectSessions(projectId)[0]
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('the window closed')
    expect(wantsMic()).toBe(false)
  })

  it('refuses overlapping conversations and ignores an unrelated renderer closing', async () => {
    const mine = await start(7)
    if (mine.status !== 'ok') throw new Error('did not start')
    expect(await start(8)).toMatchObject({ status: 'failed' })
    endForSender(8, 'the window closed')
    expect(liveSessionCount()).toBe(1)
    expect(selectSessionRow(mine.sessionId)?.status).toBe('live')
    endForSender(7, 'the window closed')
    expect(liveSessionCount()).toBe(0)
    expect(await start(8)).toMatchObject({ status: 'ok' })
  })

  it('is closed when the app quits', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    expect(quitHandler).toBeTruthy()

    quitHandler?.()

    expect(liveSessionCount()).toBe(0)
    expect(selectSessionRow(started.sessionId)?.status).toBe('failed')
  })

  it('is swept on the next launch when nothing got the chance to close it', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    // What a kill -9 leaves behind: a live row and no listener that ever ran.
    closeDb()

    const row = selectSessions(projectId)[0]
    expect(row?.status).toBe('ended')
    expect(row?.error).toBe('interrupted')
  })
})

describe('ending a session', () => {
  it('closes the row and returns what the list needs', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    const summary = endSession(started.sessionId, {
      status: 'ended',
      turns: [{ seq: 0, role: 'user', text: 'bonjour', at: new Date().toISOString() }]
    })

    expect(summary?.status).toBe('ended')
    expect(summary?.turns).toBe(1)
    expect(summary?.title).toBe('bonjour')
    expect(liveSessionCount()).toBe(0)
  })

  it('records why a session failed, so the list can say so', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    const summary = endSession(started.sessionId, { status: 'failed', error: 'the connection dropped' })
    expect(summary?.status).toBe('failed')
    expect(summary?.error).toBe('the connection dropped')
  })

  it('is safe to call twice, which a stop and a teardown both do', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)

    endSession(started.sessionId, { status: 'ended' })
    expect(() => endSession(started.sessionId, { status: 'ended' })).not.toThrow()
    expect(selectSessions(projectId)).toHaveLength(1)
  })
})

describe('coach diagnostics', () => {
  it('logs tool successes and failures without arguments, file content or results', async () => {
    const records: import('../src/core/logging/types').LogRecord[] = []
    log.addSink({ name: 'coach-test', minLevel: 'info', write: record => { records.push(record) } })
    try {
      const result = await start()
      if (result.status !== 'ok') throw new Error('Session did not start')
      await executeCoachTool(result.sessionId, 1, 'write_file', JSON.stringify({ path: 'private.md', content: 'PRIVATE CONTENT' }))
      await executeCoachTool(result.sessionId, 1, 'read_file', JSON.stringify({ path: 'missing.md' }))
      const tools = records.filter(record => record.message.startsWith('Coach tool'))
      expect(tools.map(record => record.level)).toEqual(['info', 'warn'])
      expect(JSON.stringify(tools)).not.toMatch(/PRIVATE CONTENT|private.md|missing.md/)
      expect(tools[0].data).toMatchObject({ sessionId: result.sessionId, projectId, tool: 'write_file', ok: true })
      expect(() => reportCoachResponse(result.sessionId, 999, { event: 'response.done' })).toThrow(/another window/)
      reportCoachResponse(result.sessionId, 1, { event: 'response.done', status: 'cancelled', reason: 'PRIVATE CONTENT', responseId: 'resp_test', errorCode: 'rate_limit_exceeded', errorType: 'tokens' })
      expect(records.at(-1)?.data).toMatchObject({ errorCode: 'rate_limit_exceeded', errorType: 'tokens' })
      expect(records.at(-1)?.level).toBe('warn')
      expect(JSON.stringify(records.at(-1))).not.toContain('PRIVATE CONTENT')
      reportCoachResponse(result.sessionId, 1, {
        event: 'session.error', clientEventId: 'coach_7', errorCode: 'missing_required_parameter',
        errorType: 'invalid_request_error', wrappingUp: true
      })
      expect(records.at(-1)?.level).toBe('warn')
      expect(records.at(-1)?.data).toMatchObject({
        event: 'session.error', clientEventId: 'coach_7', errorCode: 'missing_required_parameter', wrappingUp: true
      })
      reportCoachResponse(result.sessionId, 1, {
        event: 'session.error', clientEventId: 'PRIVATE CONTENT', errorCode: 'PRIVATE CONTENT', errorType: 'PRIVATE CONTENT'
      })
      expect(JSON.stringify(records.at(-1))).not.toContain('PRIVATE CONTENT')
    } finally { log.removeSink('coach-test') }
  })
})


describe('Live ownership and exactly-once tools', () => {
  it('uses the shared voice for existing coaches and freezes it until the next session', async () => {
    updateProject(projectId, { voice: 'echo' })
    setDefaultCoachVoice('cedar')
    const result = await start()
    if (result.status !== 'ok') throw new Error('not started')
    expect(result.voice).toBe('cedar')
    setDefaultCoachVoice('shimmer')
    await connectSession(result.sessionId, 'v=0 offer', 1)
    expect(JSON.parse(calls.at(-1)!.body).session.audio.output.voice).toBe('cedar')
    expect(selectSessionSummary(result.sessionId)?.metadata?.voice).toBe('cedar')
    endSession(result.sessionId, { status: 'ended', turns: [] })
    expect(await start()).toMatchObject({ status: 'ok', voice: 'shimmer' })
    expect(selectSessionSummary(result.sessionId)?.metadata?.voice).toBe('cedar')
  })
  it('uses shared reasoning over legacy overrides and freezes it in the session snapshot', async () => {
    updateProject(projectId, { backendReasoning: 'low' })
    setDefaultCoachBackendReasoning('high')
    const result = await start()
    if (result.status !== 'ok') throw new Error('not started')
    setDefaultCoachBackendReasoning('low')
    await connectSession(result.sessionId, 'v=0 offer', 1)
    expect(JSON.parse(calls.at(-1)!.body).session.delegation.responses.reasoning).toEqual({ effort: 'high' })
    expect(selectSessionSummary(result.sessionId)?.metadata?.backendSettings?.reasoning).toBe('high')
  })
  it('uses shared models for existing coaches and freezes them for connection and session titles', async () => {
    // A legacy model that is no longer supported must not block the shared default.
    const { db } = await import('../src/main/db')
    db().prepare('UPDATE projects SET model = ?, backend_model = ? WHERE id = ?').run('retired-voice-model', 'gpt-4o', projectId)
    setDefaultCoachBackendModel('gpt-6-sol')
    const result = await start()
    if (result.status !== 'ok') throw new Error('not started')
    expect(result.model).toBe('gpt-live-1')
    expect(result.backendModel).toBe('gpt-6-sol')
    setDefaultCoachBackendModel('gpt-6-luna')
    await connectSession(result.sessionId, 'v=0 offer', 1)
    expect(JSON.parse(calls.at(-1)!.body).session.delegation.responses.model).toBe('gpt-6-sol')
    expect(selectSessionSummary(result.sessionId)?.metadata?.backendModel).toBe('gpt-6-sol')
    expect(selectSessionSummary(result.sessionId)?.model).toBe('gpt-live-1')
    endSession(result.sessionId, { status: 'ended', turns: [] })
    const next = await start()
    expect(next).toMatchObject({ status: 'ok', model: 'gpt-live-1', backendModel: 'gpt-6-luna' })
  })
  it('lists available background models separately from voice models, with an offline fallback', async () => {
    const { listCoachBackendModels } = await import('../src/main/openai')
    responses['/models'] = [{ status: 200, body: JSON.stringify({ data: ['gpt-live-1', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5-mini', 'gpt-4o-audio-preview', 'o3', 'gpt-5-pro'].map(id => ({ id })) }) }]
    const result = await listCoachBackendModels(GOOD)
    expect(result.source).toBe('api')
    expect(result.models.map(m => m.id)).toEqual(['gpt-6-luna', 'gpt-5-mini', 'gpt-6-sol', 'o3'])
    responses['/models'] = [{ status: 503, body: 'unavailable' }]
    expect(await listCoachBackendModels(GOOD)).toMatchObject({ source: 'fallback', models: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }] })
  })
  it('sends the frozen voice/backend config, preserving optional tool arguments', async () => {
    const result = await start()
    if (result.status !== 'ok') throw new Error('not started')
    await connectSession(result.sessionId, 'v=0 offer', 1)
    const body = JSON.parse(calls.at(-1)!.body)
    expect(body).toMatchObject({transport: {type: 'webrtc', sdp: 'v=0 offer'}, session: {
      model: 'gpt-live-1', instructions: result.instructions,
      delegation: {type: 'responses', responses: {model: 'gpt-6-luna', instructions: result.backendInstructions, tool_choice: 'auto', parallel_tool_calls: false}}
    }})
    expect(body.session.delegation.responses.reasoning).toBeUndefined()
    expect(body.session.delegation.responses.tools.every((t: any) => t.strict === false)).toBe(true)
    expect(selectSessionSummary(result.sessionId)?.metadata).toMatchObject({backendModel: 'gpt-6-luna', remoteSessionId: 'live_remote'})
  })
  it('executes repeated append events once in main and resumes those notes in another session', async () => {
    const result = await start()
    if (result.status !== 'ok') throw new Error('not started')
    const args = JSON.stringify({path: 'context.md', content: 'French: practised passé composé.'})
    const results = await Promise.all([
      executeCoachTool(result.sessionId, 1, 'append_file', args, 'call_repeat'),
      executeCoachTool(result.sessionId, 1, 'append_file', args, 'call_repeat')
    ])
    expect(results.every(r => r.ok)).toBe(true)
    expect(toolCaps(result.sessionId).toolCalls).toBe(1)
    expect(selectToolCalls(result.sessionId)).toHaveLength(1)
    await expect(executeCoachTool(result.sessionId, 1, 'append_file', '{}', 'call_repeat')).rejects.toThrow('identity')
    endSession(result.sessionId, {status: 'ended'})
    const second = await start()
    if (second.status !== 'ok') throw new Error('not started')
    expect(second.backendInstructions).toContain('context.md')
    const read = await executeCoachTool(second.sessionId, 1, 'read_file', JSON.stringify({path: 'context.md'}), 'call_resume')
    expect(read.ok).toBe(true)
    expect(read.output.match(/French:/g)).toHaveLength(1)
    expect(read.output).toContain('passé composé')
  })
  it('does not let a destroyed renderer prevent cleanup', async () => {
    const gone = {...sender(19), isDestroyed: () => false, send: () => {throw new Error('destroyed')}}
    const result = await startSession(gone as any, projectId)
    if (result.status !== 'ok') throw new Error('not started')
    expect(() => endForSender(19, 'window lost')).not.toThrow()
    expect(liveSessionCount()).toBe(0)
    expect(wantsMic()).toBe(false)
  })
})

it('does not offer Coach models without a key', async () => {
  const { listLiveModels, listCoachBackendModels } = await import('../src/main/openai')
  expect(await listLiveModels('')).toEqual({ models: [], source: 'fallback' })
  expect(await listCoachBackendModels('')).toEqual({ models: [], source: 'fallback' })
})
