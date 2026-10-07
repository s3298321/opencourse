/**
 * The whole session, without a socket.
 *
 * A recorded stream of realtime events goes in; a transcript in the database
 * and files on disk come out. This is the check that de-risks the live session:
 * everything between "the model said something" and "a note was written" is
 * exercised here, offline, in milliseconds.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionState, reduceRealtimeEvent } from '@core/coach/events'
import type { SessionEffect, SessionState } from '@core/coach/events'
import { TRASH_DIR } from '@core/coach/files'
import {
  assistantDone,
  chunks,
  exchange,
  responseDone,
  toolDelta,
  toolDone,
  userDone
} from './helpers/realtime-events'

const root = mkdtempSync(join(tmpdir(), 'opencourse-pipeline-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  },
  net: { fetch: () => Promise.reject(new Error('the pipeline test must not reach the network')) }
}))

const { newSessionId } = await import('../src/core/coach/ids')
const { createUser, deleteUser, listUsers } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { insertSession, saveTurns, selectTurns } = await import('../src/main/coachdb')
const { createProject, updateProject, workspaceDir } = await import('../src/main/coach')
const { listFiles } = await import('../src/main/coachfiles')
const { runCoachTool } = await import('../src/main/coachtools')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const CAPS = { toolCalls: 0, searches: 0, maxToolCalls: 60, maxSearches: 20 }
const AT = '2026-09-14T10:00:00.000Z'

let n = 0
let projectId = ''
let sessionId = ''

beforeEach(() => {
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
  createUser('Ada')
  projectId = createProject({ name: 'French vocabulary' }).id
  sessionId = newSessionId()
  insertSession({ id: sessionId, projectId, startedAt: AT, model: 'gpt-realtime-2.1', instructions: 'be a coach' })
})

/**
 * What the renderer does with the data channel: parse, reduce, act on the
 * effects, flush the turns. Kept faithful to the real order of operations so a
 * bug here is a bug there.
 */
async function play(events: readonly unknown[]): Promise<{
  state: SessionState
  ran: { name: string; ok: boolean; summary: string; output: string }[]
}> {
  let state = emptySessionState()
  const pending: SessionEffect[] = []
  const ran: { name: string; ok: boolean; summary: string; output: string }[] = []
  const caps = { ...CAPS }

  for (const event of events) {
    const step = reduceRealtimeEvent(state, event, AT)
    state = step.state
    pending.push(...step.effects)
  }

  for (const effect of pending) {
    if (effect.kind === 'turn') saveTurns(sessionId, [effect.turn])
    if (effect.kind !== 'tool') continue
    const result = await runCoachTool(sessionId, effect.call.name, effect.call.arguments, caps)
    caps.toolCalls += 1
    if (effect.call.name === 'web_search') caps.searches += 1
    ran.push({ name: effect.call.name, ok: result.ok, summary: result.summary, output: result.output })
  }
  return { state, ran }
}

/** The tool call a coach makes, as a stream of argument deltas. */
function call(id: string, name: string, args: Record<string, unknown>): unknown[] {
  const json = JSON.stringify(args)
  return [...chunks(json, 9).map((chunk) => toolDelta(id, name, chunk)), toolDone(id, name)]
}

describe('a session, end to end', () => {
  it('lands a transcript in the database and notes on disk', async () => {
    const { ran } = await play([
      ...exchange('u1', 'bonjour, je veux apprendre des mots', 'a1', 'très bien, commençons'),
      ...call('c1', 'write_file', { path: 'context.md', content: '# French\n\nSam wants travel vocabulary.\n' }),
      ...call('c2', 'append_file', { path: 'learned.md', content: '- le chien - dog\n' }),
      ...call('c3', 'append_file', { path: 'learned.md', content: '- le chat - cat\n' }),
      responseDone('r1', 3),
      ...exchange('u2', 'et le mot pour book', 'a2', 'le livre')
    ])

    expect(ran.map((entry) => entry.ok)).toEqual([true, true, true])
    expect(selectTurns(sessionId).map((turn) => turn.text)).toEqual([
      'bonjour, je veux apprendre des mots',
      'très bien, commençons',
      'et le mot pour book',
      'le livre'
    ])
    expect(readFileSync(join(workspaceDir(projectId), 'learned.md'), 'utf8')).toBe(
      '- le chien - dog\n- le chat - cat\n'
    )
    expect(readFileSync(join(workspaceDir(projectId), 'context.md'), 'utf8')).toContain('travel vocabulary')
  })

  it('keeps accented content while refusing an accented name, and says which', async () => {
    const { ran } = await play([
      ...call('c1', 'write_file', { path: 'révisions.md', content: 'être' }),
      ...call('c2', 'write_file', { path: 'revisions.md', content: 'être, avoir' })
    ])

    expect(ran[0]?.ok).toBe(false)
    expect(ran[0]?.output).toMatch(/letters, digits, dot, dash and underscore/)
    expect(ran[1]?.ok).toBe(true)
    expect(readFileSync(join(workspaceDir(projectId), 'revisions.md'), 'utf8')).toBe('être, avoir')
  })

  it('refuses a write outside the project without touching anything', async () => {
    const { ran } = await play([...call('c1', 'write_file', { path: '../../users.json', content: '[]' })])
    expect(ran[0]?.ok).toBe(false)
    expect(readdirSync(dataDir)).toContain('users.json')
    expect(JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8')).users).toHaveLength(1)
  })

  it('reads back what it wrote, which is how a session picks up from the last one', async () => {
    const { ran } = await play([
      ...call('c1', 'write_file', { path: 'learned.md', content: '- le chien\n' }),
      ...call('c2', 'read_file', { path: 'learned.md' })
    ])
    expect(JSON.parse(ran[1]?.output as string).content).toBe('- le chien\n')
  })

  it('tells the coach what is there, and what is not', async () => {
    const { ran } = await play([
      ...call('c1', 'write_file', { path: 'learned.md', content: 'x' }),
      ...call('c2', 'list_files', {}),
      ...call('c3', 'read_file', { path: 'nothing-here.md' })
    ])
    expect(JSON.parse(ran[1]?.output as string).files.join()).toMatch(/learned\.md/)
    expect(ran[2]?.ok).toBe(false)
    expect(ran[2]?.output).toMatch(/list_files/)
  })

  it('recovers from a truncated tool call instead of ending the session', async () => {
    const { ran } = await play([
      toolDelta('c1', 'write_file', '{"path":"learn'),
      toolDone('c1', 'write_file'),
      ...call('c2', 'write_file', { path: 'learned.md', content: 'second try' })
    ])
    expect(ran[0]?.ok).toBe(false)
    expect(ran[0]?.output).toMatch(/valid JSON/)
    expect(ran[1]?.ok).toBe(true)
    expect(readFileSync(join(workspaceDir(projectId), 'learned.md'), 'utf8')).toBe('second try')
  })
})

describe('what the coach is not allowed to do', () => {
  it('cannot delete unless the project says so', async () => {
    await play([...call('c1', 'write_file', { path: 'learned.md', content: 'x' })])
    const { ran } = await play([...call('c2', 'delete_file', { path: 'learned.md' })])

    expect(ran[0]?.ok).toBe(false)
    expect(ran[0]?.output).toMatch(/cannot delete/)
    expect(listFiles(projectId).some((node) => node.name === 'learned.md')).toBe(true)
  })

  it('deletes to the trash when the project does say so', async () => {
    updateProject(projectId, { allowDelete: true })
    await play([...call('c1', 'write_file', { path: 'learned.md', content: 'x' })])
    const { ran } = await play([...call('c2', 'delete_file', { path: 'learned.md' })])

    expect(ran[0]?.ok).toBe(true)
    expect(readdirSync(join(workspaceDir(projectId), TRASH_DIR))).toHaveLength(1)
  })

  it('cannot reach another project, even naming its session', async () => {
    const other = createProject({ name: 'Chess' }).id
    // The project comes from the session row; the model has no say in it.
    await play([...call('c1', 'write_file', { path: 'learned.md', content: 'french' })])

    expect(listFiles(other)).toHaveLength(0)
    expect(listFiles(projectId).some((node) => node.name === 'learned.md')).toBe(true)
  })

  it('stops running tools once the session cap is reached', async () => {
    const caps = { toolCalls: 60, searches: 0, maxToolCalls: 60, maxSearches: 20 }
    const result = await runCoachTool(sessionId, 'write_file', '{"path":"a.md","content":"x"}', caps)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/all the tool calls/)
    expect(listFiles(projectId)).toHaveLength(0)
  })

  it('stops searching once the search cap is reached, without stopping the rest', async () => {
    const caps = { toolCalls: 0, searches: 20, maxToolCalls: 60, maxSearches: 20 }
    const search = await runCoachTool(sessionId, 'web_search', '{"query":"anything"}', caps)
    expect(search.ok).toBe(false)
    expect(search.output).toMatch(/web searches/)

    const write = await runCoachTool(sessionId, 'write_file', '{"path":"a.md","content":"x"}', caps)
    expect(write.ok).toBe(true)
  })

  it('refuses a session id that does not exist', async () => {
    const result = await runCoachTool('cs_000000000000', 'list_files', '{}', { ...CAPS })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/does not exist/)
  })

  it('reports a failed search as something to carry on from', async () => {
    // The electron mock rejects every fetch, which is what an offline Mac does.
    const result = await runCoachTool(sessionId, 'web_search', '{"query":"le chien"}', { ...CAPS })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/search/)
    expect(result.output).not.toMatch(/sk-/)
  })
})

describe('the wrap-up', () => {
  it('is the tool calls that follow the final turn, and they land like any other', async () => {
    const wrapUp = [
      userDone('u9', 'ok, on arrête là'),
      assistantDone('a9', 'à la prochaine'),
      ...call('c9', 'write_file', { path: 'review.md', content: '# A reviser\n\n- etre\n' }),
      ...call('c10', 'write_file', { path: 'context.md', content: 'Session 1: greetings. Verbs next.\n' }),
      responseDone('r9', 2)
    ]
    const { ran } = await play(wrapUp)

    expect(ran.every((entry) => entry.ok)).toBe(true)
    expect(readFileSync(join(workspaceDir(projectId), 'review.md'), 'utf8')).toContain('etre')
    expect(readFileSync(join(workspaceDir(projectId), 'context.md'), 'utf8')).toContain('Verbs next')
  })

  it('reports no tool calls when the coach answered in words, which is what forces a second ask', async () => {
    let state = emptySessionState()
    const effects: SessionEffect[] = []
    for (const event of [assistantDone('a9', 'noted!'), responseDone('r9', 0)]) {
      const step = reduceRealtimeEvent(state, event, AT)
      state = step.state
      effects.push(...step.effects)
    }
    const done = effects.find((effect) => effect.kind === 'responseDone')
    expect(done && done.kind === 'responseDone' && done.toolCallCount).toBe(0)
    expect(listFiles(projectId)).toHaveLength(0)
  })
})
