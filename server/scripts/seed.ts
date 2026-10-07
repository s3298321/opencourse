/**
 * Fills a development server with something to look at:
 *
 *   npm run dev                    # in one terminal
 *   npm run seed                   # in another
 *
 * Signs up a few accounts through the API (reading their codes from the
 * development outbox), publishes docs/example-course and every course in
 * content/ the way the app does - fresh ids, as uids, zipped with their
 * assets - and adds some of them as other accounts, so the catalog has
 * learners to count. Only for a development server: it needs /dev/outbox.
 *
 * OPENCOURSE_SERVER_URL picks the server (default http://127.0.0.1:8787).
 * Then make an administrator: npm run admin -- grant-admin ada
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { CourseManifest } from '@core/types'
import { identifyManifest } from '@core/course-document'
import { publishedManifest } from '@core/catalog/identity'
import { makeZip, type ZipMember } from '../../app/tests/helpers/zip'

const base = (process.env['OPENCOURSE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const repo = resolve(import.meta.dirname, '..', '..')
const PASSWORD = 'correct horse battery'

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

async function account(username: string): Promise<string> {
  const email = `${username}@example.org`
  try {
    return (await api<{ token: string }>('POST', '/api/v1/auth/login', { login: username, password: PASSWORD })).token
  } catch { /* not there yet */ }
  await api('POST', '/api/v1/auth/register/start', { email })
  const { messages } = await api<{ messages: { to: string; text: string }[] }>('GET', '/dev/outbox')
  const code = [...messages].reverse().find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1]
  if (!code) throw new Error(`No code for ${email}: is this a development server?`)
  const { ticket } = await api<{ ticket: string }>('POST', '/api/v1/auth/register/verify', { email, code })
  return (await api<{ token: string }>('POST', '/api/v1/auth/register/complete', { ticket, username, password: PASSWORD })).token
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

async function publishDir(dir: string, token: string, versions: string[], notes: string[]): Promise<string> {
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
  const courseId = randomUUID()
  const local = identifyManifest(manifest, randomUUID)
  const work = mkdtempSync(join(tmpdir(), 'opencourse-seed-'))
  try {
    for (const [i, version] of versions.entries()) {
      const published = publishedManifest({ ...local, version }, courseId)
      const assets: ZipMember[] = files(dir).filter((f) => !f.endsWith('course.json')).map((f) => ({ name: relative(dir, f).split('\\').join('/'), bytes: readFileSync(f) }))
      const zip = makeZip(join(work, `${version}.zip`), [{ name: 'course.json', content: JSON.stringify(published) }, ...assets])
      const response = await fetch(`${base}/api/v1/courses/${courseId}/versions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'x-opencourse-release-note': encodeURIComponent(notes[i] ?? '') },
        body: readFileSync(zip)
      })
      if (!response.ok) throw new Error(`publish ${manifest.title} ${version}: ${response.status} ${await response.text()}`)
    }
    console.log(`  published ${manifest.title} (${versions.join(', ')})`)
    return courseId
  } finally { rmSync(work, { recursive: true, force: true }) }
}

const ada = await account('ada'), grace = await account('grace')
const learners = await Promise.all(['lin', 'kit', 'sam', 'noor'].map(account))
console.log(`Signed up ada, grace and four learners on ${base} (password: ${PASSWORD})`)

const dirs = [join(repo, 'docs', 'example-course'), ...(existsSync(join(repo, 'content')) ? readdirSync(join(repo, 'content')).map((d) => join(repo, 'content', d)) : [])]
  .filter((dir) => existsSync(join(dir, 'course.json')))
const published: string[] = []
for (const [i, dir] of dirs.entries()) {
  try {
    published.push(await publishDir(dir, i % 2 ? grace : ada, i === 0 ? ['0.1.0', '0.2.0', '1.0.0'] : ['1.0.0', '1.1.0'], ['First release.', 'Clearer examples, and a new quiz on the second lesson.', 'Reworked the project.']))
  } catch (error) { console.warn(`  skipped ${dir}: ${(error as Error).message}`) }
}
for (const [i, token] of learners.entries()) {
  for (const id of published.slice(0, published.length - (i % 2))) await api('POST', `/api/v1/courses/${id}/download`, { intent: 'add' }, token).catch(() => {})
}
console.log(`Done. Open ${base.replace('8787', '5173')} - and make ada an administrator with: npm run admin -- grant-admin ada`)
