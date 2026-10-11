/**
 * Starting and ending a live session, with OpenAI and the microphone stubbed.
 *
 * The behaviour worth pinning here is all about failure: a refused microphone
 * must not have cost an API call, an expired secret must be re-minted exactly
 * once, and a session must never be left claiming to be live - whether the
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
  if (url.includes('client_secrets')) {
    return { status: 200, body: JSON.stringify({ value: 'ek_test_secret', expires_at: Math.floor(Date.now() / 1000) + 600 }) }
  }
  if (url.includes('/calls')) return { status: 200, body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' }
  return { status: 200, body: JSON.stringify({ data: [{ id: 'gpt-realtime-2.1' }] }) }
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
const { selectSessionRow, selectSessions } = await import('../src/main/coachdb')
const { createProject, updateProject, deleteProject } = await import('../src/main/coach')
const { getCoachAllowDelete, setCoachAllowDelete } = await import('../src/main/preferences')
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
    expect(started.model).toBe('gpt-realtime-2.1')
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

  it('sends the whole session shape when it mints, so the call is right from the first byte', async () => {
    await start()
    const mint = calls.find((call) => call.url.includes('client_secrets'))
    expect(mint).toBeTruthy()
    const body = JSON.parse(mint?.body ?? '{}')
    expect(body.session.type).toBe('realtime')
    expect(body.session.model).toBe('gpt-realtime-2.1')
    expect(body.session.audio.output.voice).toBeTruthy()
    // Without input transcription, half the conversation never reaches the database.
    expect(body.session.audio.input.transcription).toBeTruthy()
    expect(body.session.audio.input.noise_reduction).toEqual({ type: 'far_field' })
    expect(body.session.audio.input.turn_detection).toEqual({
      type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true
    })
    expect(body.session.tools.map((tool: { name: string }) => tool.name)).toContain('write_file')
    expect(mint?.auth).toContain(GOOD)
  })

  it('withholds the delete tool until the global setting allows it', async () => {
    const off = await start()
    expect(off.status === 'ok' && (off.tools as { name: string }[]).map((t) => t.name)).not.toContain('delete_file')

    updateProject(projectId, { allowDelete: true })
    const legacy = await start(2)
    expect(legacy.status === 'ok' && (legacy.tools as { name: string }[]).map(t => t.name)).not.toContain('delete_file')
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

  it('reports an OpenAI refusal as an outcome, not an exception', async () => {
    responses = { client_secrets: [{ status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) }] }
    const started = await start()
    expect(started).toEqual({ status: 'failed', message: 'slow down' })
    expect(selectSessions(projectId)).toHaveLength(0)
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
  it('trades the offer for an answer, using the secret the renderer never saw', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    calls = []

    const { answerSdp } = await connectSession(started.sessionId, 'v=0\r\noffer\r\n')
    expect(answerSdp).toContain('v=0')
    const sdpCall = calls.find((call) => call.url.includes('/calls'))
    expect(sdpCall?.auth).toBe('Bearer ek_test_secret')
    expect(sdpCall?.body).toContain('offer')
  })

  it('re-mints once when OpenAI refuses the secret, and then gives up', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    calls = []
    responses = {
      '/calls': [
        { status: 401, body: JSON.stringify({ error: { message: 'expired' } }) },
        { status: 200, body: 'v=0\r\nanswer\r\n' }
      ]
    }

    const { answerSdp } = await connectSession(started.sessionId, 'v=0\r\noffer\r\n')
    expect(answerSdp).toContain('answer')
    expect(calls.filter((call) => call.url.includes('client_secrets'))).toHaveLength(1)
    expect(calls.filter((call) => call.url.includes('/calls'))).toHaveLength(2)
  })

  it('stops after the second refusal instead of looping on a bill', async () => {
    const started = await start()
    if (started.status !== 'ok') throw new Error(started.status)
    responses = {
      '/calls': [
        { status: 401, body: '{}' },
        { status: 401, body: '{}' },
        { status: 401, body: '{}' }
      ]
    }

    await expect(connectSession(started.sessionId, 'v=0\r\n')).rejects.toThrow()
    expect(calls.filter((call) => call.url.includes('/calls')).length).toBeLessThanOrEqual(3)
  })

  it('refuses to connect a session that is not running', async () => {
    await expect(connectSession('cs_000000000000', 'v=0\r\n')).rejects.toThrow(/not running/)
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

  it('leaves another renderer’s session alone', async () => {
    const mine = await start(7)
    const theirs = await start(8)
    if (mine.status !== 'ok' || theirs.status !== 'ok') throw new Error('did not start')

    endForSender(7, 'the window closed')

    expect(liveSessionCount()).toBe(1)
    expect(selectSessionRow(theirs.sessionId)?.status).toBe('live')
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
    } finally { log.removeSink('coach-test') }
  })
})
