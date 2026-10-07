import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { CourseManifest } from '@core/types'
import { identifyManifest } from '@core/course-document'
import { publishedManifest } from '@core/catalog/identity'
import { buildApp } from '../src/app'
import { Outbox } from '../src/auth/mailer'
import type { ServerConfig } from '../src/config'
import type { Ctx } from '../src/context'
import { makeZip, type ZipMember } from '../../app/tests/helpers/zip'

export interface TestServer { app: FastifyInstance; ctx: Ctx; outbox: Outbox; dir: string; close: () => Promise<void> }

export async function testServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'opencourse-server-'))
  const config: ServerConfig = {
    port: 0, host: '127.0.0.1', dataDir: join(dir, 'data'), name: 'Test server', description: 'A server for tests.',
    publicUrl: 'http://127.0.0.1:8787', smtpUrl: null, mailFrom: 'test@localhost', registration: 'open', dev: false, trustProxy: false,
    // The web app's source template: the markers the shell fills are the ones the build keeps.
    appUrl: 'https://opencourse.dev/download', webDir: join(__dirname, '..', 'web'),
    ...overrides
  }
  const outbox = new Outbox(false)
  const { app, ctx } = await buildApp({ config, mailer: outbox, logger: false })
  return { app, ctx, outbox, dir, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** The code in the newest mail to this address. */
export function lastCode(outbox: Outbox, email: string): string {
  const mail = [...outbox.messages].reverse().find((m) => m.to === email)
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1]
  if (!code) throw new Error(`No code mailed to ${email}`)
  return code
}

let accounts = 0
/** Signs up a fresh account the way the app does, and returns its token. */
export async function signUp(server: TestServer, name = `user${++accounts}`): Promise<{ token: string; username: string; email: string; id: string }> {
  const email = `${name}@example.org`
  const start = await server.app.inject({ method: 'POST', url: '/api/v1/auth/register/start', payload: { email } })
  if (start.statusCode !== 202) throw new Error(start.body)
  const verify = await server.app.inject({ method: 'POST', url: '/api/v1/auth/register/verify', payload: { email, code: lastCode(server.outbox, email) } })
  const ticket = verify.json().ticket as string
  const done = await server.app.inject({ method: 'POST', url: '/api/v1/auth/register/complete', payload: { ticket, username: name, password: 'correct horse battery' } })
  if (done.statusCode !== 201) throw new Error(done.body)
  return { token: done.json().token, username: name, email, id: done.json().account.id }
}

export const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

/** A course with every kind of thing the overview must not leak. */
export function richCourse(): CourseManifest {
  return {
    schema_version: '1.5', slug: 'llvm-basics', title: 'Introduction to LLVM', version: '0.1.0',
    description: 'Learn **LLVM IR** from the ground up.', subject: 'Programming', difficulty: 'intermediate', author: 'Ada',
    tags: ['LLVM', 'Compilers'], prerequisites: ['Some C'],
    modules: [{
      slug: 'basics', title: 'Basics', lessons: [{
        slug: 'ssa', title: 'Static single assignment', estimated_minutes: 20,
        blocks: [
          { type: 'markdown', slug: 'intro', content: 'SSA means every value is assigned once.' },
          { type: 'quiz', slug: 'check', id: 'check', kind: 'single', question: 'How often is an SSA value assigned?', options: [{ id: 'once', text: 'Exactly once', correct: true }, { id: 'many', text: 'Any number of times', correct: false }], explanation: 'SECRET-EXPLANATION' },
          { type: 'exercise', slug: 'ex', id: 'ex', title: 'Write IR', prompt: 'Return 42.', runtime: { language: 'llvm-ir' }, starter_code: 'define i32 @main() { ret i32 0 }', solution: 'SECRET-SOLUTION', expected_output: 'SECRET-OUTPUT', verification_instructions: 'Run it', hints: ['SECRET-HINT'] }
        ],
        flashcards: [{ id: 'card', question: 'What is SSA?', answer: 'SECRET-ANSWER' }]
      }]
    }, {
      slug: 'more', title: 'Going further', lessons: [{ slug: 'phi', title: 'Phi nodes', blocks: [{ type: 'markdown', slug: 'phi', content: 'Phi picks a value by predecessor.' }] }]
    }]
  }
}

/** A local course (fresh nodeIds) and the published manifest a publish would send. */
export function localCourse(manifest: CourseManifest = richCourse()): { courseId: string; local: CourseManifest } {
  return { courseId: randomUUID(), local: identifyManifest(manifest, randomUUID) }
}

let zips = 0
export function archive(dir: string, manifest: CourseManifest, extra: ZipMember[] = []): Buffer {
  const path = makeZip(join(dir, `course-${++zips}.zip`), [{ name: 'course.json', content: JSON.stringify(manifest) }, ...extra])
  return readFileSync(path)
}

export async function publish(server: TestServer, token: string, courseId: string, local: CourseManifest, version: string, options: { note?: string; extra?: ZipMember[] } = {}) {
  const manifest = publishedManifest({ ...local, version }, courseId)
  return server.app.inject({
    method: 'POST', url: `/api/v1/courses/${courseId}/versions`,
    headers: { ...auth(token), 'content-type': 'application/zip', ...(options.note ? { 'x-opencourse-release-note': encodeURIComponent(options.note) } : {}) },
    payload: archive(server.dir, manifest, options.extra)
  })
}
