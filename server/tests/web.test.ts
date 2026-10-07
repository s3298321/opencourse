import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOOT_ELEMENT_ID, type Boot } from '../shared/boot'
import { PAGES } from '../shared/pages'
import { auth, localCourse, publish, richCourse, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const page = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: 'GET', url, headers: { accept: 'text/html', ...headers } })

/** The boot data exactly as the browser will parse it. */
function bootOf(html: string): Boot {
  const match = new RegExp(`<script type="application/json" id="${BOOT_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html)
  if (!match) throw new Error('no boot data in the page')
  return JSON.parse(match[1]!) as Boot
}

const hostileTitle = '</script><script>alert("t")</script> Course'

describe('the web app\'s shell', () => {
  it('runs only this origin\'s script, and nothing inline', async () => {
    const home = await page('/')
    expect(home.statusCode).toBe(200)
    const csp = String(home.headers['content-security-policy'])
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(home.headers['x-content-type-options']).toBe('nosniff')
    // Every <script> in the page is either an external file or a JSON data block.
    for (const tag of home.body.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc=|type="application\/json"/)
  })

  it('keeps an author\'s words as text in the title, the previews and the boot data', async () => {
    const author = await signUp(server, 'webauthor')
    const hostile = { ...richCourse(), title: hostileTitle, description: 'Hello <img src=x onerror=alert(1)> **bold** "quoted"', tags: ['<b>tag</b>'] }
    const { courseId, local } = localCourse(hostile)
    await publish(server, author.token, courseId, local, '0.1.0', { note: 'Line one\n<script>x</script>' })

    const course = await page(`/courses/${courseId}`)
    expect(course.statusCode).toBe(200)
    expect(course.body).toContain('<title>&lt;/script&gt;&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt; Course · Test server</title>')
    expect(course.body).toContain('<meta property="og:description" content="Hello &lt;img src=x onerror=alert(1)&gt; bold &quot;quoted&quot;">')
    // The only </script> that closes anything is the boot block's own.
    expect(course.body.match(/<\/script>/g)).toHaveLength((course.body.match(/<script\b/g) ?? []).length)
    expect(course.body).not.toMatch(/<img src=x/)
    const boot = bootOf(course.body)
    expect(boot.page?.data).toMatchObject({ kind: 'course', course: { id: courseId, title: hostileTitle } })
    // The overview carries no answers, wherever it travels.
    for (const secret of ['SECRET', 'Exactly once']) expect(course.body).not.toContain(secret)

    const home = bootOf((await page('/?q=course')).body)
    expect(home.page).toMatchObject({ path: '/', search: '?q=course', data: { kind: 'catalog', page: { total: 1 } } })
  })

  it('answers 404 for a course that is not listed, and for an address that is no page', async () => {
    const author = await signUp(server, 'unlister')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '0.1.0')
    await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${courseId}`, headers: auth(author.token) })
    for (const url of [`/courses/${courseId}`, `/courses/${randomUUID()}`, '/no/such/page']) {
      const response = await page(url)
      expect(response.statusCode, url).toBe(404)
      expect(response.body).toContain('<title>Not found · Test server</title>')
      expect(bootOf(response.body).page).toBeNull()
    }
    // An API path stays JSON, whatever the client accepts.
    const api = await page('/api/v1/nothing')
    expect(api.statusCode).toBe(404)
    expect(api.json().error.code).toBe('not_found')
  })

  it('knows every page in the shared table, and keeps account pages out of search engines', async () => {
    for (const p of PAGES) {
      const url = p.path.replace(/:id/, randomUUID())
      const response = await page(url)
      if (p.key === 'course' || p.key === 'myCourse') continue
      expect(response.statusCode, url).toBe(200)
      expect(response.body).toContain(`<meta name="robots" content="${p.index ? 'index, follow' : 'noindex, nofollow'}">`)
    }
    const robots = (await page('/robots.txt')).body
    expect(robots).toContain('Disallow: /admin')
    expect(robots).toContain('Disallow: /settings')
    expect(robots).toContain('Sitemap: http://127.0.0.1:8787/sitemap.xml')
  })

  it('tells the page who is signed in, by the cookie, with nothing secret', async () => {
    await signUp(server, 'reader')
    const login = await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'reader', password: 'correct horse battery', session: 'cookie' } })
    const token = login.cookies.find((c) => c.name === 'ocs_session')!.value
    const signedIn = await server.app.inject({ method: 'GET', url: '/settings', headers: { accept: 'text/html' }, cookies: { ocs_session: token } })
    const boot = bootOf(signedIn.body)
    expect(boot.account).toMatchObject({ username: 'reader', role: 'member' })
    expect(signedIn.body).not.toContain(token)
    expect(signedIn.headers['cache-control']).toBe('no-store')
    expect(bootOf((await page('/settings')).body).account).toBeNull()
    expect(boot.server).toMatchObject({ name: 'Test server', publicUrl: 'http://127.0.0.1:8787', appUrl: 'https://opencourse.dev/download' })
  })

  it('lists only listed courses in the sitemap', async () => {
    const author = await signUp(server, 'mapper')
    const shown = localCourse(), hidden = localCourse()
    await publish(server, author.token, shown.courseId, shown.local, '0.1.0')
    await publish(server, author.token, hidden.courseId, hidden.local, '0.1.0')
    await server.app.inject({ method: 'DELETE', url: `/api/v1/courses/${hidden.courseId}`, headers: auth(author.token) })
    const sitemap = await page('/sitemap.xml')
    expect(sitemap.headers['content-type']).toContain('application/xml')
    expect(sitemap.body).toContain(`/courses/${shown.courseId}</loc>`)
    expect(sitemap.body).not.toContain(hidden.courseId)
  })
})

describe('the built files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opencourse-web-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), readFileSync(join(__dirname, '..', 'web', 'index.html')))
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
    writeFileSync(join(dir, 'favicon-32.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('serves hashed assets forever, pictures for a day, and never the raw shell', async () => {
    await server.close()
    server = await testServer({ webDir: dir })
    const asset = await page('/assets/index-abc123.js')
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await page('/favicon-32.png')).headers['cache-control']).toBe('public, max-age=86400')
    const raw = await page('/index.html')
    expect(raw.statusCode).toBe(404)
    expect(raw.body).not.toContain('<!--oc-boot-->')
    expect((await page('/assets/missing.js')).statusCode).toBe(404)
  })
})
