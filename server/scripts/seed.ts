/**
 * Fills a development server with something to look at. `npm run dev` runs it
 * once the API answers; `npm run seed` runs it again by hand.
 *
 * Signs up a few accounts through the API (reading their codes from the
 * development outbox), publishes docs/example-course - the course the format
 * doc ships - the way the app does: fresh ids, as uids, zipped with its
 * assets. Then the learners add it, so the catalog has learners to count.
 * It also publishes docs/example-document, a PDF for the document catalog and
 * reader. Running it again publishes nothing new. Only for a development
 * server: it needs /dev/outbox.
 *
 * OPENCOURSE_SERVER_URL picks the server (default http://127.0.0.1:8787).
 * OPENCOURSE_SEED_DOCUMENT=0 leaves the document out, as e2e does: its
 * document catalog starts empty. OPENCOURSE_SEED_SAMPLES=1 (scripts/dev.mjs
 * sets it) also publishes the app's committed fixture courses as grace, so the
 * catalog - and the website's "From the catalog", which wants three - has
 * more than one course to show.
 * Then make an administrator: npm run admin -- grant-admin ada
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { CourseManifest } from '@core/types'
import { identifyManifest } from '@core/course-document'
import { publishedManifest } from '@core/catalog/identity'
import { DEV_AUTHOR, DEV_LEARNERS, DEV_PASSWORD, DEV_SAMPLE_COURSES, DEV_SECOND_AUTHOR } from '@core/dev-seed'
import { makeZip, type ZipMember } from '../../app/tests/helpers/zip'

const base = (process.env['OPENCOURSE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const repo = resolve(import.meta.dirname, '..', '..')
const PASSWORD = DEV_PASSWORD

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
    if(process.env['OPENCOURSE_SEED_FRESH']==='1')throw new Error('Fresh database')
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

const ada = await account(DEV_AUTHOR)
const grace = await account(DEV_SECOND_AUTHOR)
const learners = await Promise.all(DEV_LEARNERS.map(account))
console.log(`Signed up ${DEV_AUTHOR}, ${DEV_SECOND_AUTHOR} and ${DEV_LEARNERS.length} learners on ${base} (password: ${PASSWORD})`)

const example = join(repo, 'docs', 'example-course')
const slug = (JSON.parse(readFileSync(join(example, 'course.json'), 'utf8')) as CourseManifest).slug
const owned = (await api<{ courses: { id: string; slug: string }[] }>('GET', '/api/v1/me/courses', undefined, ada)).courses
const id = owned.find((course) => course.slug === slug)?.id
  ?? await publishDir(example, ada, ['0.1.0', '0.2.0', '1.0.0'], ['First release.', 'Clearer examples, and a new quiz on the second lesson.', 'Reworked the project.'])
for (const token of learners) await api('POST', `/api/v1/courses/${id}/download`, { intent: 'add' }, token).catch(() => {})

if (process.env['OPENCOURSE_SEED_SAMPLES'] === '1') {
  const mine = (await api<{ courses: { slug: string }[] }>('GET', '/api/v1/me/courses', undefined, grace)).courses
  for (const name of DEV_SAMPLE_COURSES) {
    const dir = join(repo, 'app', 'tests', 'fixtures', 'courses', name)
    const sample = (JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest).slug
    if (!mine.some((course) => course.slug === sample)) await publishDir(dir, grace, ['1.0.0'], ['First release.'])
  }
}

// The package is exactly what the publish route accepts: document.json and
// document.pdf. document.html beside them is the PDF's source and stays home.
if (process.env['OPENCOURSE_SEED_DOCUMENT'] !== '0') {
  const dir = join(repo, 'docs', 'example-document')
  const metadata = JSON.parse(readFileSync(join(dir, 'document.json'), 'utf8')) as { title: string; version: string }
  const documents = (await api<{ documents: { title: string }[] }>('GET', '/api/v1/me/documents', undefined, ada)).documents
  if (!documents.some((document) => document.title === metadata.title)) {
    const work = mkdtempSync(join(tmpdir(), 'opencourse-seed-'))
    try {
      const zip = makeZip(join(work, 'document.zip'), ['document.json', 'document.pdf'].map((name) => ({ name, bytes: readFileSync(join(dir, name)) })))
      const response = await fetch(`${base}/api/v1/documents/${randomUUID()}/versions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ada}`, 'content-type': 'application/zip' },
        body: readFileSync(zip)
      })
      if (!response.ok) throw new Error(`publish ${metadata.title}: ${response.status} ${await response.text()}`)
      console.log(`  published ${metadata.title} (${metadata.version})`)
    } finally { rmSync(work, { recursive: true, force: true }) }
  }
}
console.log(`Done. Open ${base.replace('8787', '5173')} - and make ada an administrator with: npm run admin -- grant-admin ada`)
