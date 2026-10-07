import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identifyManifest } from '@core/course-document'
import type { CourseManifest } from '@core/types'
import { auth, localCourse, publish, richCourse, signUp, testServer, type TestServer } from './helpers'
import { ftsQuery } from '../src/catalog/catalog'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const get = (url: string, token?: string) => server.app.inject({ method: 'GET', url, headers: token ? auth(token) : {} })
const course = (title: string, tags: string[], lesson: string): CourseManifest => ({
  schema_version: '1.5', slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, version: '0.1.0', tags,
  modules: [{ slug: 'm', title: 'Module', lessons: [{ slug: 'l', title: lesson, blocks: [{ type: 'markdown', slug: 'b', content: 'Text' }] }] }]
})

describe('the catalog', () => {
  it('searches by keyword prefix across titles and lessons, and filters by tags together', async () => {
    const author = await signUp(server, 'cataloger')
    for (const [title, tags, lesson] of [
      ['Introduction to LLVM', ['Compilers', 'LLVM'], 'Static single assignment'],
      ['Microeconomics', ['Economics'], 'Supply and demand'],
      ['Operating systems in C', ['C', 'Systems'], 'Writing a compiler pass']
    ] as const) await publish(server, author.token, randomUUID(), identifyManifest(course(title, [...tags], lesson), randomUUID), '1.0.0')

    const titles = async (query: string) => (await get(`/api/v1/courses${query}`)).json().courses.map((c: { title: string }) => c.title).sort()
    expect(await titles('')).toHaveLength(3)
    expect(await titles('?q=intro llvm')).toEqual(['Introduction to LLVM'])
    expect(await titles('?q=compil')).toEqual(['Introduction to LLVM', 'Operating systems in C'])
    expect(await titles('?q=demand')).toEqual(['Microeconomics'])
    expect(await titles('?q=cataloger')).toHaveLength(3)
    expect(await titles('?tag=compilers')).toEqual(['Introduction to LLVM'])
    expect(await titles('?tag=COMPILERS&tag=llvm')).toEqual(['Introduction to LLVM'])
    expect(await titles('?tag=compilers&tag=economics')).toEqual([])
    expect(await titles('?q=")(* OR NEAR')).toEqual([])
    expect((await get('/api/v1/tags')).json().tags.map((t: { tag: string }) => t.tag).sort()).toEqual(['c', 'compilers', 'economics', 'llvm', 'systems'])
    expect(ftsQuery('  ')).toBeNull()
  })

  it('counts each account that added a course once, and never counts updates', async () => {
    const author = await signUp(server, 'counted')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '1.0.0')
    const download = (token: string, intent: 'add' | 'update') => server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(token), payload: { intent } })
    const [a, b] = [await signUp(server, 'reader-a'), await signUp(server, 'reader-b')]
    await download(a.token, 'add'); await download(a.token, 'add'); await download(b.token, 'add'); await download(b.token, 'update')
    expect((await get(`/api/v1/courses/${courseId}`)).json().downloads).toBe(2)
    expect((await get('/api/v1/courses?sort=downloads')).json().courses[0]).toMatchObject({ id: courseId, downloads: 2 })
    expect(server.ctx.db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get()).toMatchObject({ n: 4 })
    expect((await get(`/api/v1/courses/${courseId}/versions`, author.token)).json().versions[0]).toMatchObject({ version: '1.0.0', downloads: 2 })
    expect((await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, payload: { intent: 'add' } })).statusCode).toBe(401)
  })

  it('serves the exact archive that was published, with its version and checksum', async () => {
    const author = await signUp(server, 'archivist')
    const { courseId, local } = localCourse()
    const published = await publish(server, author.token, courseId, local, '2.3.4')
    expect(published.statusCode).toBe(201)
    const response = await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(author.token), payload: { intent: 'add' } })
    expect(response.headers['content-type']).toBe('application/zip')
    expect(response.headers['x-opencourse-version']).toBe('2.3.4')
    expect(response.headers['x-opencourse-sha256']).toBe(createHash('sha256').update(response.rawPayload).digest('hex'))
  })

  it('shows an overview with titles and counts, and none of the answers', async () => {
    const author = await signUp(server, 'teacher')
    const { courseId, local } = localCourse(richCourse())
    await publish(server, author.token, courseId, local, '0.1.0')
    const overview = (await get(`/api/v1/courses/${courseId}`)).json()
    expect(overview).toMatchObject({
      title: 'Introduction to LLVM', publisher: 'teacher', version: '0.1.0', lessonCount: 2, quizCount: 1, exerciseCount: 1, flashcardCount: 1,
      tags: ['LLVM', 'Compilers'], prerequisites: ['Some C'], ownedByYou: false, listed: true,
      outline: [{ title: 'Basics', kind: 'lessons', lessons: [{ title: 'Static single assignment', minutes: 20 }] }, { title: 'Going further', kind: 'lessons', lessons: [{ title: 'Phi nodes' }] }]
    })
    const text = JSON.stringify(overview) + JSON.stringify((await get('/api/v1/courses')).json())
    for (const secret of ['SECRET', 'Exactly once', 'correct', 'How often is an SSA value', 'define i32']) expect(text).not.toContain(secret)
  })

  it('serves a cover sandboxed, and checks what the bytes are', async () => {
    const author = await signUp(server, 'painter')
    const { courseId, local } = localCourse({ ...richCourse(), cover_image: 'assets/cover.svg' })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    await publish(server, author.token, courseId, local, '0.1.0', { extra: [{ name: 'assets/cover.svg', content: svg }] })
    const cover = await get(`/api/v1/courses/${courseId}/cover`)
    expect(cover.headers['content-type']).toContain('image/svg+xml')
    expect(cover.headers['content-security-policy']).toContain('sandbox')
    expect(cover.headers['x-content-type-options']).toBe('nosniff')
    expect((await get(`/api/v1/courses/${courseId}`)).json().hasCover).toBe(true)

    const other = localCourse({ ...richCourse(), cover_image: 'assets/cover.png' })
    await publish(server, author.token, other.courseId, other.local, '0.1.0', { extra: [{ name: 'assets/cover.png', content: '<html>not a picture</html>' }] })
    expect((await get(`/api/v1/courses/${other.courseId}`)).json().hasCover).toBe(false)
    expect((await get(`/api/v1/courses/${other.courseId}/cover`)).statusCode).toBe(404)
  })

  it('answers update checks for courses it knows, and nothing for ones it does not', async () => {
    const author = await signUp(server, 'checker')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '1.0.0')
    const status = await server.app.inject({ method: 'POST', url: '/api/v1/courses/status', payload: { ids: [courseId, randomUUID(), 'not-a-uuid'] } })
    expect(status.json().courses).toEqual([{ id: courseId, currentVersion: '1.0.0', listed: true }])
  })
})

describe('the development outbox', () => {
  it('exists only on a development server', async () => {
    expect((await get('/dev/outbox')).statusCode).toBe(404)
    await server.close()
    server = await testServer({ dev: true })
    expect((await get('/dev/outbox')).statusCode).toBe(200)
  })
})
