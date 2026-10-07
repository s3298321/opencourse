import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identifyManifest } from '@core/course-document'
import { publishedManifest } from '@core/catalog/identity'
import { archive, auth, localCourse, publish, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const get = (url: string, token?: string) => server.app.inject({ method: 'GET', url, headers: token ? auth(token) : {} })

describe('publishing versions', () => {
  it('creates a course, then only accepts higher versions - deleted ones included', async () => {
    const author = await signUp(server, 'author')
    const { courseId, local } = localCourse()
    const first = await publish(server, author.token, courseId, local, '0.1.0', { note: 'First release' })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toEqual({ courseId, version: '0.1.0', created: true })
    for (const version of ['0.1.0', '0.0.9']) {
      const refused = await publish(server, author.token, courseId, local, version)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error).toMatchObject({ code: 'version_not_higher', maxVersion: '0.1.0' })
    }
    expect((await publish(server, author.token, courseId, local, '0.10.0')).statusCode).toBe(200)
    // Deleting 0.10.0 does not free its number.
    await server.app.inject({ method: 'PUT', url: `/api/v1/courses/${courseId}/current`, headers: auth(author.token), payload: { version: '0.1.0' } })
    expect((await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${courseId}/versions/0.10.0`, headers: auth(author.token) })).statusCode).toBe(200)
    expect((await publish(server, author.token, courseId, local, '0.10.0')).json().error.code).toBe('version_not_higher')
    expect((await publish(server, author.token, courseId, local, '0.11.0')).statusCode).toBe(200)
    const managed = (await get(`/api/v1/courses/${courseId}/versions`, author.token)).json()
    expect(managed.versions.map((v: { version: string; status: string }) => `${v.version}:${v.status}`)).toEqual(['0.11.0:current', '0.10.0:deleted', '0.1.0:available'])
    expect(managed.versions.at(-1).releaseNote).toBe('First release')
  })

  it('belongs to whoever published it first', async () => {
    const author = await signUp(server, 'first-author'), other = await signUp(server, 'other')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '0.1.0')
    expect((await publish(server, other.token, courseId, local, '0.2.0')).json().error.code).toBe('not_owner')
    for (const request of [
      { method: 'PUT' as const, url: `/api/v1/courses/${courseId}/current`, payload: { version: '0.1.0' } },
      { method: 'DELETE' as const, url: `/api/v1/courses/${courseId}` },
      { method: 'GET' as const, url: `/api/v1/courses/${courseId}/versions` }
    ]) expect((await server.app.inject({ ...request, headers: auth(other.token) })).statusCode).toBeGreaterThanOrEqual(403)
    expect((await publish(server, '', courseId, local, '0.2.0')).statusCode).toBe(401)
  })

  it('keeps every element uid to one course, one kind and - for a card - one lesson', async () => {
    const author = await signUp(server, 'keeper'), thief = await signUp(server, 'thief')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '0.1.0')
    // Someone else's course reusing a uid of this one.
    const stolen = await publish(server, thief.token, randomUUID(), local, '0.1.0')
    expect(stolen.json().error.code).toBe('uid_conflict')

    const retyped = structuredClone(local)
    const block = retyped.modules[0].lessons![0].blocks[0]!
    retyped.modules[0].lessons![0].blocks[0] = { type: 'image', slug: block.slug, nodeId: block.nodeId, src: 'assets/x.png' }
    const kind = await publish(server, author.token, courseId, retyped, '0.2.0', { extra: [{ name: 'assets/x.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] })
    expect(kind.json().error.errors[0]).toContain('cannot change type')

    const moved = structuredClone(local)
    const card = moved.modules[0].lessons![0].flashcards!.pop()!
    moved.modules[1].lessons![0].flashcards = [card]
    expect((await publish(server, author.token, courseId, moved, '0.2.0')).json().error.errors[0]).toContain('bound to their lesson')

    // Moving a lesson between modules is allowed.
    const lessonMoved = structuredClone(local)
    lessonMoved.modules[1].lessons!.push(lessonMoved.modules[0].lessons!.splice(0, 1)[0]!)
    lessonMoved.modules[0].lessons = [{ slug: 'filler', title: 'Filler', blocks: [], nodeId: randomUUID() }]
    expect((await publish(server, author.token, courseId, lessonMoved, '0.2.0')).statusCode).toBe(200)
  })

  it('refuses an archive the app would refuse', async () => {
    const author = await signUp(server, 'strict')
    const { courseId, local } = localCourse()
    const send = (payload: Buffer) => server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/versions`, headers: { ...auth(author.token), 'content-type': 'application/zip' }, payload })
    const valid = publishedManifest(local, courseId)

    const old = { ...valid, schema_version: '1.4' }
    expect((await send(archive(server.dir, old))).json().error.errors[0]).toContain('publish in format 1.5')
    const noUid = structuredClone(valid); delete noUid.modules[0].uid
    expect((await send(archive(server.dir, noUid))).json().error.errors[0]).toContain('missing or invalid uid')
    const other = publishedManifest(local, randomUUID())
    expect((await send(archive(server.dir, other))).json().error.errors[0]).toContain('/uid')
    const slip = await send(archive(server.dir, valid, [{ name: '../evil.txt', content: 'x' }]))
    expect(slip.json().error.code).toBe('invalid_archive')
    const missingAsset = { ...valid, cover_image: 'assets/cover.png' }
    expect((await send(archive(server.dir, missingAsset))).json().error.errors[0]).toContain('missing asset')
    const bomb = await send(archive(server.dir, valid, [{ name: 'big.txt', content: 'x', declaredSize: 2 * 1024 * 1024 * 1024 - 1 }]))
    expect(bomb.json().error.code).toBe('invalid_archive')
    const html = await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/versions`, headers: { ...auth(author.token), 'content-type': 'text/plain' }, payload: 'hello' })
    expect(html.statusCode).toBe(415)
    expect((await get(`/api/v1/courses/${courseId}`)).statusCode).toBe(404)
  })

  it('accepts a course imported fresh, uids and all, as a different course', async () => {
    const author = await signUp(server, 'fresh')
    const { local } = localCourse()
    const copy = identifyManifest(local, randomUUID)
    const a = await publish(server, author.token, randomUUID(), local, '1.0.0')
    const b = await publish(server, author.token, randomUUID(), copy, '1.0.0')
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
  })
})

describe('managing what is published', () => {
  it('rolls back by moving the current version, and learners see the rolled-back one', async () => {
    const author = await signUp(server, 'roller'), learner = await signUp(server, 'learner')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '1.0.0')
    await publish(server, author.token, courseId, { ...local, title: 'Broken release' }, '1.1.0')
    expect((await get(`/api/v1/courses/${courseId}`)).json().version).toBe('1.1.0')

    const rolled = await server.app.inject({ method: 'PUT', url: `/api/v1/courses/${courseId}/current`, headers: auth(author.token), payload: { version: '1.0.0' } })
    expect(rolled.json()).toMatchObject({ currentVersion: '1.0.0', maxVersion: '1.1.0' })
    const overview = (await get(`/api/v1/courses/${courseId}`, learner.token)).json()
    expect(overview).toMatchObject({ version: '1.0.0', title: 'Introduction to LLVM' })
    expect(overview.versions.map((v: { version: string }) => v.version)).toEqual(['1.0.0'])
    expect((await get(`/api/v1/courses/${courseId}`, author.token)).json().versions.map((v: { status: string }) => v.status)).toEqual(['withdrawn', 'current'])
    expect((await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${courseId}/versions/1.0.0`, headers: auth(author.token) })).json().error.code).toBe('current_version')
    const download = await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(learner.token), payload: { intent: 'add' } })
    expect(download.headers['x-opencourse-version']).toBe('1.0.0')
    // Roll forward again.
    await server.app.inject({ method: 'PUT', url: `/api/v1/courses/${courseId}/current`, headers: auth(author.token), payload: { version: '1.1.0' } })
    expect((await get(`/api/v1/courses/${courseId}`)).json().version).toBe('1.1.0')
  })

  it('unpublishes without destroying, and lists again', async () => {
    const author = await signUp(server, 'hider'), learner = await signUp(server, 'seeker')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '1.0.0')
    expect((await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${courseId}`, headers: auth(author.token) })).json()).toMatchObject({ listed: false, currentVersion: '1.0.0' })
    expect((await get('/api/v1/courses')).json().total).toBe(0)
    expect((await get(`/api/v1/courses/${courseId}`, learner.token)).statusCode).toBe(404)
    expect((await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(learner.token), payload: { intent: 'update' } })).statusCode).toBe(404)
    const status = await server.app.inject({ method: 'POST', url: '/api/v1/courses/status', headers: auth(learner.token), payload: { ids: [courseId] } })
    expect(status.json().courses).toEqual([{ id: courseId, currentVersion: null, listed: false }])
    // Its owner still sees it, and a publisher on a second machine can still download it.
    expect((await get(`/api/v1/courses/${courseId}`, author.token)).json()).toMatchObject({ listed: false, ownedByYou: true })
    expect((await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(author.token), payload: { intent: 'add' } })).statusCode).toBe(200)
    expect((await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/relist`, headers: auth(author.token) })).json().listed).toBe(true)
    expect((await get('/api/v1/courses')).json().total).toBe(1)
    // Publishing a new version lists an unpublished course too.
    await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${courseId}`, headers: auth(author.token) })
    await publish(server, author.token, courseId, local, '1.1.0')
    expect((await get('/api/v1/courses')).json().total).toBe(1)
    expect((await get('/api/v1/me/courses', author.token)).json().courses).toHaveLength(1)
  })

  it('refuses an archive larger than the limit before reading it', async () => {
    const author = await signUp(server, 'huge')
    const response = await server.app.inject({ method: 'POST', url: `/api/v1/courses/${randomUUID()}/versions`, headers: { ...auth(author.token), 'content-type': 'application/zip', 'content-length': String(300 * 1024 * 1024) }, payload: Buffer.alloc(10) })
    expect(response.statusCode).toBe(413)
  })
})
