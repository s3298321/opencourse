/**
 * The coach database, against real files. node:sqlite is experimental and the
 * only database in the app, so the things that matter here are the ones that
 * happen when something has already gone wrong: a force quit mid-session, a
 * truncated file, a project directory the database has never heard of.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-coach-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  }
}))

const { newSessionId } = await import('../src/core/coach/ids')
const { createUser, deleteUser, listUsers, switchUser } = await import('../src/main/users')
const { userDbFile, coachProjectDir, coachProjectsRoot } = await import('../src/main/paths')
const { SCHEMA_VERSION, closeDb, db } = await import('../src/main/db')
const {
  deleteSessionRow,
  finishSession,
  insertSession,
  recordToolCall,
  saveTurns,
  selectSessions,
  selectToolCalls,
  selectTurns
} = await import('../src/main/coachdb')
const { createProject, deleteProject, listProjects, updateProject } = await import('../src/main/coach')
const { getDefaultCoachModel, setDefaultCoachModel } = await import('../src/main/preferences')

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
beforeEach(() => {
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
})

const startSession = (projectId: string, model = 'gpt-realtime-2.1'): string => {
  const id = newSessionId()
  insertSession({ id, projectId, startedAt: new Date().toISOString(), model, instructions: 'be a coach' })
  return id
}

describe('the schema', () => {
  it('uses the saved speech model for new coaches, preserves existing choices, and isolates users', () => {
    const user = createUser('Ada')
    const existing = createProject({ name: 'French' })
    expect(() => setDefaultCoachModel('gpt-5.1')).toThrow('speech-to-speech')
    setDefaultCoachModel('gpt-realtime')
    closeDb()
    expect(getDefaultCoachModel()).toBe('gpt-realtime')
    expect(createProject({ name: 'Chess' }).model).toBe('gpt-realtime')
    expect(createProject({ name: 'Spanish', model: 'gpt-realtime-2.1-mini' }).model).toBe('gpt-realtime-2.1-mini')
    expect(listProjects().find((project) => project.id === existing.id)!.model).toBe('gpt-realtime-2.1')
    createUser('Grace')
    expect(getDefaultCoachModel()).toBe('gpt-realtime-2.1')
    switchUser(user.id)
    expect(getDefaultCoachModel()).toBe('gpt-realtime')
  })
  it('opens at the current version with the tables the app writes to', () => {
    createUser('Ada')
    createProject({ name: 'French' })
    const version = (db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(version).toBe(SCHEMA_VERSION)
    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'turns', 'tool_calls']))
  })

  it('migrates nothing on a second open and keeps what was there', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    closeDb()
    expect(listProjects().map((p) => p.id)).toEqual([project.id])
    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION
    )
  })

  it('enforces foreign keys, so a turn cannot outlive its session', () => {
    createUser('Ada')
    expect(() => saveTurns('cs_deadbeefdead', [{ seq: 0, role: 'user', text: 'hi', at: 'now' }])).toThrow()
  })
})

describe('deleting', () => {
  it('cascades a project to its sessions, turns and tool calls', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 0, role: 'user', text: 'bonjour', at: 'now' }])
    recordToolCall(session, {
      seq: 1,
      callId: 'call_1',
      name: 'write_file',
      arguments: '{}',
      ok: true,
      at: 'now'
    })

    deleteProject(project.id)

    expect(listProjects()).toHaveLength(0)
    expect(selectSessions(project.id)).toHaveLength(0)
    expect(selectTurns(session)).toHaveLength(0)
    expect(selectToolCalls(session)).toHaveLength(0)
  })

  it('takes the workspace directory with the project', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French' })
    const dir = coachProjectDir(user.id, project.id)
    writeFileSync(join(dir, 'learned.md'), '# mots')
    expect(existsSync(dir)).toBe(true)

    deleteProject(project.id)
    expect(existsSync(dir)).toBe(false)
  })

  it('drops one session without touching its siblings', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const keep = startSession(project.id)
    const drop = startSession(project.id)
    saveTurns(keep, [{ seq: 0, role: 'user', text: 'keep', at: 'now' }])

    deleteSessionRow(drop)

    expect(selectSessions(project.id).map((s) => s.id)).toEqual([keep])
    expect(selectTurns(keep)).toHaveLength(1)
  })
})

describe('a session that did not end cleanly', () => {
  it('is swept to ended on the next open rather than staying live forever', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    expect(selectSessions(project.id)[0]?.status).toBe('live')

    // What a force quit leaves behind: the row is never finished.
    closeDb()

    const swept = selectSessions(project.id)[0]
    expect(swept?.id).toBe(session)
    expect(swept?.status).toBe('ended')
    expect(swept?.error).toBe('interrupted')
  })

  it('leaves a session that ended properly alone', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    finishSession(session, 'ended')
    closeDb()

    const row = selectSessions(project.id)[0]
    expect(row?.status).toBe('ended')
    expect(row?.error).toBeUndefined()
    expect(row?.endedAt).toBeTruthy()
  })

  it('records why a session failed, so the list can say so', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    finishSession(session, 'failed', 'the connection dropped')

    const row = selectSessions(project.id)[0]
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('the connection dropped')
  })

  it('keeps the turns it managed to flush before it died', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [
      { seq: 0, role: 'user', text: 'bonjour', at: 'now' },
      { seq: 1, role: 'assistant', text: 'salut', at: 'now' }
    ])
    closeDb()

    expect(selectTurns(session).map((t) => t.text)).toEqual(['bonjour', 'salut'])
  })
})

describe('flushing turns', () => {
  it('is idempotent, so a renderer that re-sends a flush does not double up', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    const turns = [
      { seq: 0, role: 'user' as const, text: 'bonjour', at: 'now' },
      { seq: 1, role: 'assistant' as const, text: 'salut', at: 'now' }
    ]
    saveTurns(session, turns)
    saveTurns(session, turns)

    expect(selectTurns(session)).toHaveLength(2)
  })

  it('lets a corrected turn replace the one already stored at that seq', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 0, role: 'assistant', text: 'partial…', at: 'now' }])
    saveTurns(session, [{ seq: 0, role: 'assistant', text: 'the whole thing', at: 'later' }])

    expect(selectTurns(session)).toEqual([{ seq: 0, role: 'assistant', text: 'the whole thing', at: 'later' }])
  })

  it('returns turns in order even when they arrive out of it', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 2, role: 'user', text: 'third', at: 'now' }])
    saveTurns(session, [{ seq: 0, role: 'user', text: 'first', at: 'now' }])
    saveTurns(session, [{ seq: 1, role: 'assistant', text: 'second', at: 'now' }])

    expect(selectTurns(session).map((t) => t.text)).toEqual(['first', 'second', 'third'])
  })
})

describe('a database that cannot be read', () => {
  it('is quarantined so the app opens instead of failing', () => {
    const user = createUser('Ada')
    createProject({ name: 'French' })
    closeDb()
    writeFileSync(userDbFile(user.id), 'this is not a database')

    expect(() => listProjects()).not.toThrow()

    const quarantined = readdirSync(join(dataDir, 'users', user.id, 'coach')).filter((f) => f.includes('.broken-'))
    expect(quarantined.length).toBeGreaterThan(0)
  })

  it('costs transcripts, not projects: the mirrors bring the projects back', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French vocabulary' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 0, role: 'user', text: 'bonjour', at: 'now' }])
    closeDb()
    writeFileSync(userDbFile(user.id), 'corrupt')

    const recovered = listProjects()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.name).toBe('French vocabulary')
    expect(recovered[0]?.id).toBe(project.id)
    // The transcript is gone, and that is the deal the mirror makes.
    expect(recovered[0]?.sessions).toBe(0)
  })

  it('ignores a project directory whose mirror does not name it', () => {
    const user = createUser('Ada')
    const stray = join(coachProjectsRoot(user.id), 'cp_aaaaaaaaaaaa')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'project.json'), JSON.stringify({ id: 'cp_bbbbbbbbbbbb', name: 'Mismatched' }))

    expect(listProjects()).toHaveLength(0)
  })
})

describe('per-user isolation', () => {
  it('gives each user their own database, so one cannot see the other', () => {
    const ada = createUser('Ada')
    createProject({ name: 'Ada French' })

    const bob = createUser('Bob')
    expect(listProjects()).toHaveLength(0)
    createProject({ name: 'Bob Chess' })
    expect(listProjects().map((p) => p.name)).toEqual(['Bob Chess'])

    switchUser(ada.id)
    expect(listProjects().map((p) => p.name)).toEqual(['Ada French'])
    expect(userDbFile(ada.id)).not.toBe(userDbFile(bob.id))
  })

  it('takes the database and the workspaces with a deleted user', () => {
    const ada = createUser('Ada')
    createProject({ name: 'French' })
    closeDb()
    expect(existsSync(userDbFile(ada.id))).toBe(true)

    deleteUser(ada.id)
    expect(existsSync(join(dataDir, 'users', ada.id))).toBe(false)
  })
})

describe('projects', () => {
  it('writes a self-describing mirror next to the coach files', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French' })
    const mirror = JSON.parse(readFileSync(join(coachProjectDir(user.id, project.id), 'project.json'), 'utf8'))
    expect(mirror.id).toBe(project.id)
    expect(mirror.name).toBe('French')
  })

  it('defaults to a realtime model, a voice and the coaching prompt', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    expect(project.model).toBe('gpt-realtime-2.1')
    expect(project.voice).toBeTruthy()
    expect(project.instructions).toContain('coach')
    expect(project.allowDelete).toBe(false)
  })

  it('keeps the mirror in step when the project is renamed', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French' })
    updateProject(project.id, { name: 'French vocabulary', allowDelete: true })

    const mirror = JSON.parse(readFileSync(join(coachProjectDir(user.id, project.id), 'project.json'), 'utf8'))
    expect(mirror.name).toBe('French vocabulary')
    expect(mirror.allowDelete).toBe(true)
  })

  it('counts the files a coach has written, ignoring its own mirror', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French' })
    const dir = coachProjectDir(user.id, project.id)
    writeFileSync(join(dir, 'learned.md'), 'mots')
    writeFileSync(join(dir, 'review.md'), 'mots')

    expect(listProjects()[0]?.files).toBe(2)
  })

  it('refuses a project with no name rather than creating an unnameable directory', () => {
    createUser('Ada')
    expect(() => createProject({ name: '   ' })).toThrow(/name/)
  })
})
