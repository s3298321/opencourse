/**
 * The coach database, against real files. node:sqlite is experimental and the
 * only database in the app, so the things that matter here are the ones that
 * happen when something has already gone wrong: a force quit mid-session, a
 * truncated file, a project directory the database has never heard of.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs'
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
const { userDbFile, coachProjectDir, coachProjectsRoot, userPreferencesFile } = await import('../src/main/paths')
const { SCHEMA_VERSION, closeDb, db } = await import('../src/main/db')
const {
  deleteSessionRow,
  deleteProjectRow,
  finishSession,
  insertSession,
  recordToolCall,
  saveTurns,
  saveFragments,
  selectFragments,
  selectSessionSummary,
  selectSessions,
  selectToolCalls,
  selectTurns
} = await import('../src/main/coachdb')
const { updateSessionMetadata } = await import('../src/main/coachdb')
const { createProject, deleteProject, getProject, listProjects, updateProject, workspaceDir } = await import('../src/main/coach')
const { getDefaultCoachModel, setDefaultCoachModel, getDefaultCoachBackendModel, setDefaultCoachBackendModel } = await import('../src/main/preferences')

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
  it('persists user defaults, applies them to new coaches, and honors per-coach choices', () => {
    const ada = createUser('Ada')
    const existing = createProject({ name: 'Existing' })
    expect(getDefaultCoachBackendModel()).toBe('gpt-6-luna')
    setDefaultCoachModel('gpt-live-1')
    setDefaultCoachBackendModel('gpt-6-sol')
    closeDb()
    const next = createProject({ name: 'New coach' })
    expect(next).toMatchObject({ model: 'gpt-live-1', backendModel: 'gpt-6-sol' })
    expect(getProject(existing.id)?.backendModel).toBe('gpt-6-luna')
    expect(createProject({ name: 'Override', backendModel: 'gpt-5-mini' }).backendModel).toBe('gpt-5-mini')
    expect(() => setDefaultCoachBackendModel('gpt-live-1')).toThrow('background model')
    expect(getDefaultCoachBackendModel()).toBe('gpt-6-sol')
    createUser('Grace')
    expect(getDefaultCoachBackendModel()).toBe('gpt-6-luna')
    switchUser(ada.id)
    expect(getDefaultCoachBackendModel()).toBe('gpt-6-sol')
  })
  it('migrates existing coaches to the default background model without losing transcripts', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 0, role: 'user', text: 'Bonjour', at: 'now' }])
    db().exec('ALTER TABLE projects DROP COLUMN backend_model; PRAGMA user_version = 19')
    closeDb()
    expect(getProject(project.id)?.backendModel).toBe('gpt-6-luna')
    expect(selectTurns(session)[0].text).toBe('Bonjour')
    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  })
  it('saves the background model in the database and recovery mirror', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French' })
    expect(project.backendModel).toBe('gpt-6-luna')
    updateProject(project.id, { backendModel: 'gpt-6-sol' })
    closeDb()
    expect(getProject(project.id)?.backendModel).toBe('gpt-6-sol')
    expect(JSON.parse(readFileSync(join(coachProjectDir(user.id, project.id), 'project.json'), 'utf8')).backendModel).toBe('gpt-6-sol')
    closeDb()
    writeFileSync(userDbFile(user.id), 'corrupt')
    listProjects()
    expect(getProject(project.id)?.backendModel).toBe('gpt-6-sol')
  })
  it('rejects audio and other specialized models as the coaching backend', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    for (const backendModel of ['gpt-live-1', 'gpt-4o-audio-preview', 'text-embedding-3-small', 'gpt-5.1-chat-latest', 'gpt-5-pro', '']) {
      expect(() => updateProject(project.id, { backendModel })).toThrow('background model')
    }
    expect(getProject(project.id)?.backendModel).toBe('gpt-6-luna')
  })
  it('uses Live for new coaches and rejects non-conversational models', () => {
    createUser('Ada')
    expect(() => setDefaultCoachModel('gpt-live-transcribe')).toThrow('speech-to-speech')
    expect(() => createProject({ name: 'Bad', model: 'gpt-realtime' })).toThrow('GPT-Live')
    setDefaultCoachModel('gpt-live-1')
    closeDb()
    expect(getDefaultCoachModel()).toBe('gpt-live-1')
    expect(createProject({ name: 'Chess' }).model).toBe('gpt-live-1')
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
  it('keeps a generated title across reopen and late transcript or metadata flushes', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    const session = startSession(project.id)
    saveTurns(session, [{ seq: 0, role: 'user', text: 'Bonjour', at: 'now' }])
    finishSession(session, 'ended')
    expect(selectSessionSummary(session)?.title).toBe('Bonjour')
    updateSessionMetadata(session, { generatedTitle: 'Horizons des trous noirs' })
    updateSessionMetadata(session, { finalization: 'confirmed' })
    saveTurns(session, [{ seq: 1, role: 'assistant', text: 'À bientôt', at: 'later' }])
    closeDb()
    expect(selectSessionSummary(session)?.title).toBe('Horizons des trous noirs')
    expect(selectSessions(project.id)[0].title).toBe('Horizons des trous noirs')
    expect(selectTurns(session)).toHaveLength(2)
  })
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

  it('defaults to a Live model, a voice and the coaching prompt', () => {
    createUser('Ada')
    const project = createProject({ name: 'French' })
    expect(project.model).toBe('gpt-live-1')
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

describe('staged project deletion recovery', () => {
  it('restores a workspace when a crash happened before the database delete', () => {
    createUser('Ada')
    const project = createProject({ name: 'Restore' })
    const dir = workspaceDir(project.id)
    writeFileSync(join(dir, 'context.md'), 'Keep this note')
    const staged = join(dir, '..', `.deleted-${project.id}`)
    renameSync(dir, staged)
    expect(listProjects().some(p => p.id === project.id)).toBe(true)
    expect(readFileSync(join(dir, 'context.md'), 'utf8')).toBe('Keep this note')
    expect(existsSync(staged)).toBe(false)
  })
  it('cleans a committed deletion without re-adopting its mirror', () => {
    createUser('Ada')
    const project = createProject({ name: 'Delete' })
    const dir = workspaceDir(project.id), staged = join(dir, '..', `.deleted-${project.id}`)
    renameSync(dir, staged)
    deleteProjectRow(project.id)
    expect(listProjects().some(p => p.id === project.id)).toBe(false)
    expect(existsSync(staged)).toBe(false)
  })
  it('restores workspace files when the database refuses deletion', () => {
    createUser('Ada')
    const project = createProject({name: 'French'})
    writeFileSync(join(workspaceDir(project.id), 'notes.md'), 'Retain these notes')
    db().exec("CREATE TRIGGER refuse_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'refuse delete'); END;")
    expect(() => deleteProject(project.id)).toThrow('refuse delete')
    expect(readFileSync(join(workspaceDir(project.id), 'notes.md'), 'utf8')).toBe('Retain these notes')
    expect(listProjects().map(project => project.name)).toContain('French')
  })

})


describe('Live migration and durable captions', () => {
  it('migrates rows and preferences, repairs interrupted mirrors, and preserves history and voices', () => {
    const user = createUser('Ada')
    const project = createProject({ name: 'French', voice: 'cedar', instructions: 'Mon brief exact.' })
    const session = startSession(project.id, 'gpt-realtime-2.1')
    saveTurns(session, [{seq: 0, role: 'user', text: 'bonjour', at: 'now'}])
    finishSession(session, 'ended')
    db().prepare('UPDATE projects SET model = ? WHERE id = ?').run('gpt-realtime-2.1', project.id)
    const mirrorPath = join(coachProjectDir(user.id, project.id), 'project.json')
    writeFileSync(mirrorPath, JSON.stringify({...project, model: 'gpt-realtime-2.1'}))
    writeFileSync(userPreferencesFile(user.id), JSON.stringify({defaultCoachModel: 'gpt-realtime-mini', readingScale: 1.2}))
    expect(getDefaultCoachModel()).toBe('gpt-live-1')
    expect(JSON.parse(readFileSync(userPreferencesFile(user.id), 'utf8')).defaultCoachModel).toBe('gpt-live-1')
    expect(listProjects()[0].model).toBe('gpt-live-1')
    const migrated = readFileSync(mirrorPath, 'utf8')
    expect(JSON.parse(migrated)).toMatchObject({voice: 'cedar', instructions: 'Mon brief exact.', model: 'gpt-live-1'})
    listProjects()
    expect(readFileSync(mirrorPath, 'utf8')).toBe(migrated)
    // Simulate SQLite having committed while the mirror still has the old model.
    writeFileSync(mirrorPath, JSON.stringify({...project, model: 'gpt-realtime'}))
    listProjects()
    expect(JSON.parse(readFileSync(mirrorPath, 'utf8')).model).toBe('gpt-live-1')
    expect(selectSessionSummary(session)?.model).toBe('gpt-realtime-2.1')
    expect(selectTurns(session)[0].text).toBe('bonjour')
  })
  it('migrates a Realtime project recovered from a backup mirror', () => {
    const user = createUser('Ada')
    const project = createProject({name: 'Recovered', voice: 'echo'})
    const mirror = join(coachProjectDir(user.id, project.id), 'project.json')
    writeFileSync(mirror, JSON.stringify({...project, model: 'gpt-4o-realtime-preview'}))
    deleteProjectRow(project.id)
    expect(listProjects()[0].model).toBe('gpt-live-1')
    expect(JSON.parse(readFileSync(mirror, 'utf8'))).toMatchObject({model: 'gpt-live-1', voice: 'echo'})
  })
  it('deduplicates fragments durably, accepts late captions, and uses the same live/history grouping', () => {
    createUser('Ada')
    const project = createProject({name: 'French'})
    const id = startSession(project.id, 'gpt-live-1')
    const late = {eventId: 'u2', role: 'user' as const, text: ' très bien ', startMs: 800, endMs: 1000}
    saveFragments(id, [late, {eventId: 'a1', role: 'assistant', text: 'Oui', startMs: 500, endMs: 600}])
    saveFragments(id, [late, {eventId: 'u1', role: 'user', text: 'Je vais', startMs: 0, endMs: 400}])
    closeDb()
    expect(selectFragments(id)).toHaveLength(3)
    expect(selectTurns(id).map(t => t.text)).toEqual(['Je vais très bien ', 'Oui'])
    expect(() => saveFragments(id, [{...late, startMs: -1}])).toThrow()
    expect(selectFragments(id)).toHaveLength(3)
    deleteSessionRow(id)
    expect(selectFragments(id)).toHaveLength(0)
  })
})
