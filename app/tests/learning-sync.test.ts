// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { LearningState } from '../src/core/learning/types'
const root = mkdtempSync(join(tmpdir(), 'opencourse-learning-test-'))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(root, name), getAppPath: () => resolve('.'), isPackaged: false, on: () => {} },
  dialog: {},
  net: {
    fetch: () => {
      throw Error('injected')
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))
let cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  const { stopLearningSync } = await import('../src/main/learning')
  stopLearningSync()
  for (const close of cleanup) await close()
  const { closeDb } = await import('../src/main/db')
  closeDb()
  rmSync(root, { force: true, recursive: true })
})
beforeAll(async () => {
  const { setServerFetch } = await import('../src/main/serverclient')
  setServerFetch((url, init) => fetch(url, init))
})
it('downloads web enrollments, isolates identical IDs by server and account, and recovers journaled offline actions', async () => {
  const { testServer, signUp, localCourse, publish, auth } = await import('../../server/tests/helpers')
  const { createUser } = await import('../src/main/users'),
    { signIn, serverAccess } = await import('../src/main/servers'),
    { syncAll, stopLearningSync } = await import('../src/main/learning'),
    { db } = await import('../src/main/db'),
    { readProgress, writeProgress } = await import('../src/main/progress'),
    { readDocument } = await import('../src/main/course-store'),
    { journalProgress, learningPreference } = await import('../src/main/learning-store')
  createUser('Learner')
  const fixture = localCourse(),
    servers: {
      server: Awaited<ReturnType<typeof testServer>>
      account: Awaited<ReturnType<typeof signUp>>
      connection: Awaited<ReturnType<typeof signIn>>
      base: string
      state: LearningState
    }[] = []
  for (let i = 0; i < 2; i++) {
    const server = await testServer({ webDir: null })
    cleanup.push(server.close)
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
    const account = await signUp(server, `learner${i}`)
    expect((await publish(server, account.token, fixture.courseId, fixture.local, '1.0.0')).statusCode).toBe(201)
    const state = (
      await server.app.inject({
        method: 'PUT',
        url: `/api/v1/me/learning/course/${fixture.courseId}`,
        headers: auth(account.token),
        payload: {}
      })
    ).json() as LearningState
    const connection = await signIn(base, account.email, 'correct horse battery')
    servers.push({ server, account, connection, base, state })
  }
  await syncAll(true)
  stopLearningSync()
  const bindings = db().prepare('SELECT * FROM learning_bindings').all() as {
    local_id: string
    remote_id: string
    connection_id: string
    server_id: string
  }[]
  expect(bindings).toHaveLength(2)
  expect(bindings[0].local_id).not.toBe(bindings[1].local_id)
  const first = bindings.find((b) => b.connection_id === servers[0].connection.id)!,
    second = bindings.find((b) => b.connection_id === servers[1].connection.id)!
  const manifest = readDocument(first.local_id).manifest!,
    lesson = manifest.modules[0].lessons![0].nodeId!,
    otherLesson = readDocument(second.local_id).manifest!.modules[0].lessons![0].nodeId!
  expect(lesson).not.toBe(otherLesson)
  const before = readProgress(first.local_id),
    after = { ...before, completedLessons: [lesson] }
  journalProgress(before, after)
  expect(readProgress(first.local_id).completedLessons).toEqual([lesson])
  expect(db().prepare('SELECT * FROM learning_progress_journal').all()).toHaveLength(0)
  await syncAll(true)
  stopLearningSync()
  const remote = fixture.local.modules[0].lessons![0].nodeId!
  const state = () =>
    servers[0].server.app
      .inject({ url: '/api/v1/me/learning', headers: auth(servers[0].account.token) })
      .then((r) => r.json().items[0] as LearningState)
  expect((await state()).fields[`lesson:${remote}`].value).toBe(true)
  expect(readProgress(second.local_id).completedLessons).toEqual([])
  // A web deletion removes the account's private desktop cache via the change feed.
  const remoteChat = (await servers[0].server.app.inject({
    method: 'POST', url: '/api/v1/learning/chats', headers: auth(servers[0].account.token),
    payload: { kind: 'course', id: fixture.courseId, version: '1.0.0' }
  })).json().chat.id
  await syncAll(true)
  stopLearningSync()
  expect(db().prepare('SELECT id FROM learning_chat_cache WHERE id=?').get(remoteChat)).toBeTruthy()
  await servers[0].server.app.inject({
    method: 'DELETE', url: `/api/v1/learning/chats/${remoteChat}`, headers: auth(servers[0].account.token)
  })
  await syncAll(true)
  stopLearningSync()
  expect(db().prepare('SELECT id FROM learning_chat_cache WHERE id=?').get(remoteChat)).toBeUndefined()
  // Web activity reaches desktop, including an explicit reset.
  const current = await state()
  await servers[0].server.app.inject({
    method: 'POST',
    url: '/api/v1/sync',
    headers: auth(servers[0].account.token),
    payload: {
      operations: [
        {
          ...current.enrollment,
          idempotencyKey: randomUUID(),
          epoch: current.epoch,
          at: Date.now(),
          field: 'reset',
          value: null
        }
      ]
    }
  })
  await syncAll(true)
  stopLearningSync()
  expect(readProgress(first.local_id).completedLessons).toEqual([])
  learningPreference(first.local_id, 'readingScale', 1.5)
  expect(learningPreference(first.local_id, 'readingScale')?.value).toBe(1.5)
  await syncAll(true)
  stopLearningSync()
  expect((await state()).fields['preference:readingScale'].value).toBe(1.5)
  expect(learningPreference(second.local_id, 'readingScale')?.value).toBeUndefined()
  // Version selection changes only on acceptance, and downloaded identities survive updates.
  const revised = structuredClone(fixture.local)
  revised.modules[0].lessons![0].title = 'Revised lesson'
  expect(
    (await publish(servers[0].server, servers[0].account.token, fixture.courseId, revised, '2.0.0')).statusCode
  ).toBe(200)
  await syncAll(true)
  stopLearningSync()
  expect(readDocument(first.local_id).origin?.version).toBe('1.0.0')
  await servers[0].server.app.inject({
    method: 'PUT',
    url: `/api/v1/me/learning/course/${fixture.courseId}`,
    headers: auth(servers[0].account.token),
    payload: { version: '2.0.0' }
  })
  await syncAll(true)
  stopLearningSync()
  expect(readDocument(first.local_id).origin?.version).toBe('2.0.0')
  expect(readDocument(first.local_id).manifest!.modules[0].lessons![0].nodeId).toBe(lesson)
  // Pending work remains with its original account through replacement.
  writeProgress({ ...readProgress(first.local_id), completedLessons: [lesson] })
  const pending = db().prepare('SELECT account_id FROM learning_outbox').all()
  expect(pending).toHaveLength(1)
  const replacement = await signUp(servers[0].server, 'replacement')
  await signIn(servers[0].base, replacement.email, 'correct horse battery')
  await syncAll(true)
  stopLearningSync()
  expect(db().prepare('SELECT account_id FROM learning_outbox').all()).toEqual(pending)
  expect(
    (await servers[0].server.app.inject({ url: '/api/v1/me/learning', headers: auth(replacement.token) })).json().items
  ).toEqual([])
  await signIn(servers[0].base, servers[0].account.email, 'correct horse battery')
  expect(serverAccess(servers[0].connection.id).account?.id).toBe(servers[0].account.id)
  await syncAll(true)
  stopLearningSync()
  expect(db().prepare('SELECT * FROM learning_outbox').all()).toHaveLength(0)
  expect((await state()).fields[`lesson:${remote}`].value).toBe(true)
}, 30000)
it('keeps exercise code in step between the web and the desktop workspace', async () => {
  const { testServer, signUp, localCourse, publish, auth } = await import('../../server/tests/helpers')
  const { signIn } = await import('../src/main/servers'),
    { syncAll, stopLearningSync } = await import('../src/main/learning'),
    { db } = await import('../src/main/db'),
    { openExercise, writeExerciseFile, readExerciseFile } = await import('../src/main/workspace'),
    { createUser } = await import('../src/main/users')
  createUser('Coder')
  const fixture = localCourse(),
    server = await testServer({ webDir: null })
  cleanup.push(server.close)
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`,
    account = await signUp(server, 'coder')
  expect((await publish(server, account.token, fixture.courseId, fixture.local, '1.0.0')).statusCode).toBe(201)
  const web = async () =>
    (
      await server.app.inject({
        method: 'PUT',
        url: `/api/v1/me/learning/course/${fixture.courseId}`,
        headers: auth(account.token),
        payload: {}
      })
    ).json() as LearningState
  const exercise = fixture.local.modules[0].lessons![0].blocks.find((b) => b.type === 'exercise')!.nodeId!
  const typeOnWeb = async (code: string) => {
    const s = await web()
    const r = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: auth(account.token),
      payload: {
        operations: [
          { ...s.enrollment, epoch: s.epoch, idempotencyKey: randomUUID(), at: Date.now(), field: `code:${exercise}`, value: code }
        ]
      }
    })
    expect(r.json().rejected).toEqual([])
  }
  await web()
  const connection = await signIn(base, account.email, 'correct horse battery')
  await syncAll(true)
  stopLearningSync()
  const local = (
    db().prepare('SELECT local_id FROM learning_bindings WHERE connection_id=?').get(connection.id) as { local_id: string }
  ).local_id
  const { readDocument } = await import('../src/main/course-store')
  const localExercise = readDocument(local).manifest!.modules[0].lessons![0].blocks.find((b) => b.type === 'exercise')!
    .nodeId!
  const target = { courseId: local, blockId: localExercise }
  // Written on the web before the exercise was ever opened here: the first open shows it, not the starter.
  await typeOnWeb('print("from the web")\n')
  await syncAll(true)
  stopLearningSync()
  expect(openExercise(target).content).toBe('print("from the web")\n')
  // Edited here: the server receives it, and only the newest unsent draft is queued.
  let mtime = readExerciseFile(target).mtimeMs
  for (const draft of ['print(1)\n', 'print("from the app")\n']) {
    const written = writeExerciseFile(target, draft, mtime)
    expect(written.ok).toBe(true)
    if (written.ok) mtime = written.mtimeMs
  }
  expect(
    (db().prepare('SELECT payload FROM learning_outbox').all() as { payload: string }[]).filter((r) =>
      r.payload.includes(`code:${exercise}`)
    )
  ).toHaveLength(1)
  await syncAll(true)
  stopLearningSync()
  expect((await web()).fields[`code:${exercise}`].value).toBe('print("from the app")\n')
  // The web changes it again and the file here has not moved since: the open workspace takes it.
  await typeOnWeb('print("web again")\n')
  await syncAll(true)
  stopLearningSync()
  expect(readExerciseFile(target).content).toBe('print("web again")\n')
  expect(openExercise(target).content).toBe('print("web again")\n')
}, 30000)
