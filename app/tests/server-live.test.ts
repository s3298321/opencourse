// @vitest-environment node
/**
 * The whole server journey against the real server (server/), in-process on an
 * ephemeral port: sign up by code, publish, find, add, learn, publish again,
 * update with progress kept, roll back, unpublish, edit into a local copy.
 *
 * Opt-in, because it needs server/ installed:
 *   OPENCOURSE_TEST_SERVER=1 npx vitest run tests/server-live.test.ts
 * Nothing here reaches past 127.0.0.1.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { courseNodes, identifyManifest } from '../src/core/course-document'
import type { CourseManifest, QuizBlock } from '../src/core/types'
import { emptyProgress } from '../src/core/progress'

const live = process.env['OPENCOURSE_TEST_SERVER'] === '1'
const root = mkdtempSync(join(tmpdir(), 'opencourse-server-live-'))
const dataDir = join(root, 'app')
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)), getAppPath: () => resolve('.'), isPackaged: false, on: () => {} },
  dialog: {},
  net: { fetch: () => { throw new Error('use the injected fetch') } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer: Buffer) => [...buffer.toString().replace(/^enc:/, '')].reverse().join('')
  }
}))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))

type Outbox = { messages: { to: string; text: string }[] }
let base = '', close: () => Promise<void> = async () => {}, outbox: Outbox

beforeAll(async () => {
  if (!live) return
  mkdirSync(dataDir, { recursive: true })
  const { buildApp } = await import('../../server/src/app')
  const { Outbox } = await import('../../server/src/auth/mailer')
  outbox = new Outbox(false)
  const config = { port: 0, host: '127.0.0.1', dataDir: join(root, 'server'), name: 'Live test server', description: 'For the live test.', publicUrl: 'http://127.0.0.1', smtpUrl: null, mailFrom: 'test@localhost', registration: 'open' as const, dev: false, trustProxy: false, appUrl: 'https://opencourse.dev/download', webDir: null }
  const { app } = await buildApp({ config, mailer: outbox as never, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  close = () => app.close()
  const { setServerFetch } = await import('../src/main/serverclient')
  setServerFetch((url, init) => fetch(url, init))
})
afterAll(async () => { await close(); rmSync(root, { recursive: true, force: true }) })

const code = (email: string): string => [...outbox.messages].reverse().find((m) => m.to === email)!.text.match(/\b(\d{6})\b/)![1]!

function course(): CourseManifest {
  return {
    schema_version: '1.5', slug: 'live-course', title: 'A live course', version: '0.1.0', tags: ['Live', 'Testing'],
    modules: [{ slug: 'one', title: 'One', lessons: [
      { slug: 'first', title: 'First lesson', blocks: [
        { type: 'markdown', slug: 'text', content: 'Hello.' },
        { type: 'quiz', slug: 'q', id: 'q', kind: 'single', question: 'Pick one', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }], explanation: 'HIDDEN-EXPLANATION' }
      ] },
      { slug: 'second', title: 'Second lesson', blocks: [{ type: 'markdown', slug: 'text', content: 'Goodbye.' }] }
    ] }]
  }
}

describe.skipIf(!live)('a course\'s life on a server', () => {
  it('goes from one author to one learner and back, keeping the learner\'s progress', async () => {
    const users = await import('../src/main/users')
    const servers = await import('../src/main/servers')
    const catalog = await import('../src/main/catalog')
    const serverCourses = await import('../src/main/server-courses')
    const publish = await import('../src/main/publish')
    const authoring = await import('../src/main/course-authoring')
    const { readDocument, courseDirectory } = await import('../src/main/course-store')
    const { readProgress, writeProgress } = await import('../src/main/progress')
    const { listCourses, reloadCourses } = await import('../src/main/courses')
    const { closeDb } = await import('../src/main/db')
    const { installCourseFixture } = await import('./helpers/course')

    const signUp = async (name: string): Promise<string> => {
      const email = `${name}@example.org`
      const started = await servers.startRegistration(base, email)
      await servers.verifyRegistration(started.flowId, code(email))
      return (await servers.completeRegistration(started.flowId, name, 'a good long password')).id
    }
    const as = (id: string): void => { servers.forgetServerSessions(); closeDb(); users.switchUser(id); reloadCourses() }

    // The author publishes a local course; its IDs become the server's.
    const author = users.createUser('Author'); as(author.id)
    const authorServer = await signUp('author')
    const local = installCourseFixture(identifyManifest(course(), randomUUID))
    const courseId = local.courseId
    const authorIds = courseNodes(readDocument(courseId).manifest).map((n) => n.id)
    expect((await publish.previewPublish(courseId, authorServer)).problems).toEqual([])
    expect(await publish.publishCourse(courseId, authorServer, 'First release')).toEqual({ courseId, version: '0.1.0', created: true })
    expect(readDocument(courseId).origin).toMatchObject({ role: 'publisher', version: '0.1.0', server: base })

    // A learner finds it, sees no answers, adds it - with the same IDs.
    const learner = users.createUser('Learner'); as(learner.id)
    const learnerServer = await signUp('learner')
    const page = await catalog.searchCatalog(learnerServer, { q: 'live' })
    expect(page.courses.map((c) => c.id)).toEqual([courseId])
    const overview = await catalog.catalogOverview(learnerServer, courseId)
    expect(JSON.stringify(overview)).not.toContain('HIDDEN-EXPLANATION')
    expect(await serverCourses.addFromServer(learnerServer, courseId)).toMatchObject({ courseId, version: '0.1.0' })
    expect(courseNodes(readDocument(courseId).manifest).map((n) => n.id)).toEqual(authorIds)
    expect(listCourses().find((c) => c.courseId === courseId)).toMatchObject({ version: '0.1.0', origin: { role: 'learner', publisher: 'author' } })
    await expect(serverCourses.addFromServer(learnerServer, courseId)).rejects.toMatchObject({ code: 'exists' })
    expect((await catalog.catalogOverview(learnerServer, courseId)).downloads).toBe(1)

    // ...and learns: the first lesson done, its quiz answered.
    const manifest = readDocument(courseId).manifest!
    const [first, second] = manifest.modules[0]!.lessons!
    const quiz = first!.blocks[1] as QuizBlock
    writeProgress({ ...emptyProgress(courseId), completedLessons: [first!.nodeId!, second!.nodeId!], quizAttempts: { [quiz.nodeId!]: { submitted: [quiz.options![0]!.nodeId!], isCorrect: true, at: 'now' } } })

    // The author edits the first lesson, drops the second, adds a third; 0.1.0 is taken, 0.2.0 is not.
    as(author.id)
    const draft = authoring.getAuthoringCourse(courseId)
    const next = structuredClone(draft.draft.manifest)
    next.modules[0]!.lessons![0]!.title = 'First lesson, revised'
    next.modules[0]!.lessons!.splice(1, 1, { nodeId: randomUUID(), slug: 'third', title: 'Third lesson', blocks: [{ nodeId: randomUUID(), type: 'markdown', slug: 'text', content: 'New.' }] })
    const saved = authoring.saveDraft(courseId, next, draft.document.revision, draft.draft.draftVersion)
    if ('status' in saved) throw new Error('conflict')
    expect(await authoring.saveCourse(courseId, draft.document.revision, saved.draftVersion, true)).toMatchObject({ status: 'ok' })
    expect((await publish.previewPublish(courseId, authorServer)).problems[0]).toContain('not higher than v0.1.0')
    const bumped = authoring.getAuthoringCourse(courseId)
    const v2 = authoring.saveDraft(courseId, { ...bumped.draft.manifest, version: '0.2.0' }, bumped.document.revision, bumped.draft.draftVersion)
    if ('status' in v2) throw new Error('conflict')
    await authoring.saveCourse(courseId, bumped.document.revision, v2.draftVersion)
    expect(await publish.publishCourse(courseId, authorServer, 'Revised')).toMatchObject({ version: '0.2.0', created: false })

    // The learner updates: the edited lesson stays done, the removed one goes, the new one is to do.
    as(learner.id)
    expect((await serverCourses.courseUpdates())[courseId]).toEqual({ kind: 'update', version: '0.2.0' })
    const preview = await serverCourses.previewCourseUpdate(courseId)
    expect(preview).toMatchObject({ from: '0.1.0', to: '0.2.0', newLessons: 1, overwritesLocalEdits: false })
    expect(preview.removed.map((n) => n.label)).toEqual(['Second lesson', 'text'])
    expect(await serverCourses.applyCourseUpdate(courseId)).toEqual({ version: '0.2.0' })
    const progress = readProgress(courseId)
    expect(progress.completedLessons).toEqual([first!.nodeId!])
    expect(progress.quizAttempts[quiz.nodeId!]).toBeDefined()
    expect(readDocument(courseId).manifest!.modules[0]!.lessons![0]!.title).toBe('First lesson, revised')
    expect(listCourses().find((c) => c.courseId === courseId)?.version).toBe('0.2.0')
    expect(existsSync(join(courseDirectory(courseId), 'package.next'))).toBe(false)

    // The author rolls back, then unpublishes; the learner is told each time.
    as(author.id)
    expect(await publish.setCurrentPublished(authorServer, courseId, '0.1.0')).toMatchObject({ currentVersion: '0.1.0', maxVersion: '0.2.0' })
    as(learner.id)
    expect((await serverCourses.courseUpdates())[courseId]).toEqual({ kind: 'switch', version: '0.1.0' })
    as(author.id)
    await publish.unpublishCourse(authorServer, courseId)
    as(learner.id)
    expect((await serverCourses.courseUpdates())[courseId]).toEqual({ kind: 'unlisted' })

    // The learner's own edits become a local copy; the downloaded course is untouched.
    const before = readFileSync(join(courseDirectory(courseId), 'document.json'), 'utf8')
    const mine = authoring.getAuthoringCourse(courseId)
    const edited = authoring.saveDraft(courseId, { ...mine.draft.manifest, title: 'My own version' }, mine.document.revision, mine.draft.draftVersion)
    if ('status' in edited) throw new Error('conflict')
    const copy = await authoring.saveCourse(courseId, mine.document.revision, edited.draftVersion)
    expect(copy).toMatchObject({ status: 'ok' })
    const copyId = (copy as { copiedTo: string }).copiedTo
    expect(copyId).toBeTruthy()
    expect(readFileSync(join(courseDirectory(courseId), 'document.json'), 'utf8')).toBe(before)
    const copied = readDocument(copyId)
    expect(copied.origin).toBeUndefined()
    expect(copied.manifest!.title).toBe('My own version')
    expect(courseNodes(copied.manifest).some((n) => authorIds.includes(n.id))).toBe(false)
    expect(readProgress(copyId).completedLessons).toEqual([])
  })
})
