import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeZip } from '../../app/tests/helpers/zip'
import { testServer, signUp, auth, localCourse, publish, richCourse, type TestServer } from './helpers'
import type { LearningOperation, LearningState } from '@core/learning/types'
import { buildApp } from '../src/app'
import { readAIKey } from '../src/learning/ai'
import { TITLE_INSTRUCTIONS } from '@core/sidechat/title'

let server: TestServer, token: string, account: string, id: string, lesson: string, card: string
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown, key = token) =>
  server.app.inject({
    method,
    url: `/api/v1${path}`,
    headers: auth(key),
    ...(payload === undefined ? {} : { payload: payload as object })
  })
async function enrolled() {
  const response = await call('PUT', `/me/learning/course/${id}`, {})
  expect(response.statusCode).toBe(200)
  return response.json() as LearningState
}
function operation(s: LearningState, field: string, value: unknown, at = Date.now()): LearningOperation {
  return {
    kind: 'course',
    id,
    version: s.enrollment.version,
    generation: s.enrollment.generation,
    epoch: s.epoch,
    idempotencyKey: randomUUID(),
    at,
    field,
    value
  }
}
const push = async (...operations: LearningOperation[]) => {
  const r = await call('POST', '/sync', { operations })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}
const current = async () => ((await call('GET', '/me/learning')).json().items as LearningState[])[0]
function pdf(text = 'A searchable document'): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const start = Buffer.byteLength(out)
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(out)
}
async function publishPdf(doc: string, version = '1.0.0', bytes = pdf()) {
  const file = makeZip(join(server.dir, `${randomUUID()}.zip`), [
    {
      name: 'document.json',
      content: JSON.stringify({ title: 'Test PDF', description: 'Document description', tags: ['PDF'], version })
    },
    { name: 'document.pdf', content: bytes.toString() }
  ])
  return server.app.inject({
    method: 'POST',
    url: `/api/v1/documents/${doc}/versions`,
    headers: { ...auth(token), 'content-type': 'application/zip' },
    payload: readFileSync(file)
  })
}
beforeEach(async () => {
  server = await testServer({ aiEncryptionKeys: JSON.stringify({ first: 'ab'.repeat(32) }), aiActiveKey: 'first' })
  const a = await signUp(server)
  token = a.token
  account = a.id
  const course = localCourse()
  id = course.courseId
  const module = course.local.modules[0]
  if (module.type === 'project') throw Error()
  lesson = module.lessons[0].nodeId!
  card = module.lessons[0].flashcards![0].nodeId!
  expect((await publish(server, token, id, course.local, '1.0.0')).statusCode).toBe(201)
})
afterEach(async () => {
  await server.close()
})
describe('learning synchronization', () => {
  it('merges fields, orders conflicts by action, deduplicates dropped acknowledgments and isolates accounts', async () => {
    const s = await enrolled(),
      a = operation(s, `lesson:${lesson}`, true, 100),
      b = operation(s, 'preference:layout', 'compact', 200)
    await push(a, b)
    await push(a)
    await push(operation(s, `lesson:${lesson}`, false, 50))
    expect((await current()).fields[`lesson:${lesson}`].value).toBe(true)
    expect((await current()).fields['preference:layout'].value).toBe('compact')
    expect(server.ctx.db.prepare('SELECT * FROM learning_events').all()).toHaveLength(3)
    const other = await signUp(server)
    expect((await call('GET', '/sync', undefined, other.token)).json().changes).toEqual([])
    expect((await call('GET', `/learn/course/${id}/1.0.0`, undefined, other.token)).statusCode).toBe(404)
  })
  it('clamps future clocks and rejects operations from before resets and unenrollment', async () => {
    let s = await enrolled()
    await push(operation(s, `lesson:${lesson}`, true, Date.now() + 1e12))
    expect((await current()).fields[`lesson:${lesson}`].at).toBeLessThanOrEqual(Date.now())
    const old = operation(s, `lesson:${lesson}`, true)
    await push(operation(s, 'reset', null))
    expect((await push(old)).rejected[0].code).toBe('stale_generation')
    s = await current()
    await push(operation(s, `lesson:${lesson}`, false, 1))
    expect((await current()).fields[`lesson:${lesson}`].value).toBe(false)
    await call('DELETE', `/me/learning/course/${id}`)
    await enrolled()
    expect((await push(operation(s, `lesson:${lesson}`, true))).rejected).toHaveLength(1)
  })
  it('replays reviews deterministically, including a reset delivered out of order', async () => {
    const s = await enrolled(),
      early = operation(s, `review:${card}`, { rating: 'good' }, 100000),
      late = operation(s, `review:${card}`, { rating: 'easy' }, 200000)
    await push(late, early)
    const state = (await current()).fields[`review:${card}`].value as { card: { reps: number } }
    expect(state.card.reps).toBe(2)
    await push(late)
    expect((await current()).fields[`review:${card}`].value).toEqual(state)
    await push(operation(s, `review:${card}`, null, 150000))
    expect(((await current()).fields[`review:${card}`].value as { card: { reps: number } }).card.reps).toBe(1)
  })
  it('retains enrolled access after unpublishing and denies it after moderation', async () => {
    await enrolled()
    expect((await call('DELETE', `/courses/${id}`)).statusCode).toBe(200)
    expect((await call('GET', `/learn/course/${id}/1.0.0`)).statusCode).toBe(200)
    const other = await signUp(server)
    expect((await call('PUT', `/me/learning/course/${id}`, {}, other.token)).statusCode).toBe(404)
    server.ctx.db.prepare('UPDATE courses SET moderated_at=? WHERE id=?').run('now', id)
    expect((await call('GET', `/learn/course/${id}/1.0.0`)).statusCode).toBe(404)
  })
  it('lists which held versions have a cover and serves it to their learners only', async () => {
    await enrolled()
    const covered = localCourse({ ...richCourse(), cover_image: 'assets/cover.svg' })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'
    expect(
      (await publish(server, token, covered.courseId, covered.local, '1.0.0', { extra: [{ name: 'assets/cover.svg', content: svg }] }))
        .statusCode
    ).toBe(201)
    expect((await call('PUT', `/me/learning/course/${covered.courseId}`, {})).statusCode).toBe(200)
    const items = (await call('GET', '/me/learning')).json().items as LearningState[]
    expect(Object.fromEntries(items.map((i) => [i.enrollment.id, i.hasCover]))).toEqual({ [id]: false, [covered.courseId]: true })
    const url = `/learn/course/${covered.courseId}/1.0.0/cover`
    const cover = await call('GET', url)
    expect(cover.statusCode).toBe(200)
    expect(cover.headers['content-type']).toContain('image/svg+xml')
    expect(cover.headers['content-security-policy']).toContain('sandbox')
    expect((await call('GET', `/learn/course/${id}/1.0.0/cover`)).statusCode).toBe(404)
    // Unlisting hides the catalog's cover, not the learner's.
    expect((await call('DELETE', `/courses/${covered.courseId}`)).statusCode).toBe(200)
    expect((await call('GET', url)).statusCode).toBe(200)
    const other = await signUp(server)
    expect((await call('GET', url, undefined, other.token)).statusCode).toBe(404)
  })
  it('syncs exercise code, refuses oversized code and keeps one state change per item', async () => {
    const s = await enrolled(),
      exercise = String(
        (server.ctx.db.prepare("SELECT uid FROM elements WHERE course_id=? AND kind='exercise'").get(id) as { uid: string })
          .uid
      )
    const draft = 'print("DRAFT-ONE")',
      final = 'print("DRAFT-TWO")'
    await push(operation(s, `code:${exercise}`, draft, 100000))
    await push(operation(s, `code:${exercise}`, final, 200000))
    expect((await current()).fields[`code:${exercise}`].value).toBe(final)
    // An older draft delivered late does not replace newer code.
    await push(operation(s, `code:${exercise}`, 'print("LATE")', 150000))
    expect((await current()).fields[`code:${exercise}`].value).toBe(final)
    // Drafts are not kept in the event log, and the change feed holds only the latest state.
    expect(JSON.stringify(server.ctx.db.prepare('SELECT * FROM learning_events').all())).not.toContain('DRAFT-')
    const changes = server.ctx.db
      .prepare("SELECT value FROM learning_changes WHERE account_id=? AND type='state'")
      .all(account) as { value: string }[]
    expect(changes).toHaveLength(1)
    expect(changes[0].value).toContain('DRAFT-TWO')
    for (const [field, value] of [
      [`code:${exercise}`, 'x'.repeat(64001)],
      [`code:${exercise}`, { text: 'not a string' }],
      [`code:${lesson}`, 'print(1)']
    ] as const) {
      const r = await call('POST', '/sync', { operations: [operation(s, field, value)] })
      if (r.statusCode === 200) expect(r.json().rejected).toHaveLength(1)
      else expect(r.statusCode).toBe(400)
    }
  })
  it('excludes answer keys and private project provenance from learner responses and sync', async () => {
    const s = await enrolled()
    const payload = await call('GET', `/learn/course/${id}/1.0.0`)
    expect(payload.body).not.toContain('SECRET-')
    await push(
      operation(
        s,
        `exercise:${String((server.ctx.db.prepare("SELECT uid FROM elements WHERE course_id=? AND kind='exercise'").get(id) as { uid: string }).uid)}`,
        { completedAt: 'today', lastReview: { chatId: 'PRIVATE' }, reviewedFingerprint: 'PRIVATE' }
      )
    )
    await push({ ...operation(s, `lesson:${lesson}`, true), localFiles: 'PRIVATE' } as LearningOperation)
    expect(JSON.stringify(server.ctx.db.prepare('SELECT * FROM learning_events').all())).not.toContain('PRIVATE')
  })
})
describe('published PDF documents', () => {
  it('publishes, indexes, supports ranges, preserves metadata-only progress and isolates replacements', async () => {
    const doc = randomUUID()
    const result = await publishPdf(doc)
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json().pages).toBe(1)
    expect(result.body).not.toContain('pdf_path')
    const s = (await call('PUT', `/me/learning/document/${doc}`, {})).json() as LearningState
    await push({ ...operation(s, 'readPage', 1), kind: 'document', id: doc })
    await vi.waitFor(
      async () =>
        expect((await call('GET', `/learn/document/${doc}/1.0.0/search?q=searchable`)).json().hits).toHaveLength(1),
      { timeout: 10000 }
    )
    const range = await server.app.inject({
      url: `/api/v1/learn/document/${doc}/1.0.0/pdf`,
      headers: { ...auth(token), range: 'bytes=0-7' }
    })
    expect(range.statusCode).toBe(206)
    expect(range.rawPayload.length).toBe(8)
    expect((await publishPdf(doc, '1.0.1')).statusCode).toBe(201)
    expect((await call('PUT', `/me/learning/document/${doc}`, { version: '1.0.1' })).json().fields.readPage.value).toBe(
      1
    )
    expect((await publishPdf(doc, '2.0.0', pdf('Replacement pages'))).statusCode).toBe(201)
    expect((await call('PUT', `/me/learning/document/${doc}`, { version: '2.0.0' })).json().fields).toEqual({})
    expect((await call('PUT', `/me/learning/document/${doc}`, { version: '1.0.0' })).json().fields.readPage.value).toBe(
      1
    )
  })
})
describe('the document catalog', () => {
  async function publishAs(key: string, doc: string, title: string, tags: string[], version = '1.0.0') {
    const file = makeZip(join(server.dir, `${randomUUID()}.zip`), [
      { name: 'document.json', content: JSON.stringify({ title, description: `About ${title}`, tags, version }) },
      { name: 'document.pdf', content: pdf().toString() }
    ])
    const r = await server.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc}/versions`,
      headers: { ...auth(key), 'content-type': 'application/zip' },
      payload: readFileSync(file)
    })
    expect(r.statusCode, r.body).toBe(201)
  }
  it('filters by tag, sorts, counts readers and lists its tags, as the course catalog does', async () => {
    const birds = randomUUID(), rocks = randomUUID()
    await publishAs(token, birds, 'Birds', ['Nature', 'Field'])
    await publishAs(token, rocks, 'Rocks', ['Nature'])
    const reader = await signUp(server)
    expect((await call('PUT', `/me/learning/document/${rocks}`, {}, reader.token)).statusCode).toBe(200)
    const list = async (query: string) => (await call('GET', `/documents${query}`)).json().documents as { id: string; downloads: number; updatedAt: string; maxVersion: string }[]
    expect((await list('?tag=field')).map((d) => d.id)).toEqual([birds])
    expect((await list('?tag=Nature&tag=Field')).map((d) => d.id)).toEqual([birds])
    expect((await list('?sort=title')).map((d) => d.id)).toEqual([birds, rocks])
    expect((await list('?sort=downloads')).map((d) => d.id)).toEqual([rocks, birds])
    expect((await list('?sort=downloads'))[0]).toMatchObject({ downloads: 1, maxVersion: '1.0.0' })
    expect((await list(''))[0]!.updatedAt).toMatch(/^\d{4}-/)
    expect((await call('GET', '/documents/tags')).json().tags).toEqual([{ tag: 'Nature', count: 2 }, { tag: 'Field', count: 1 }])
    // A moderator's removal is the owner's to learn about, and nobody else's.
    server.ctx.db.prepare('UPDATE published_documents SET moderated_at=? WHERE id=?').run(new Date().toISOString(), birds)
    expect((await call('GET', `/documents/${birds}`)).json().moderated).toBe(true)
    expect((await call('GET', `/documents/${birds}`, undefined, reader.token)).statusCode).toBe(404)
    expect((await call('GET', '/documents/tags')).json().tags).toEqual([{ tag: 'Nature', count: 1 }])
    expect((await call('GET', '/me/documents')).json().documents.map((d: { id: string }) => d.id).sort()).toEqual([birds, rocks].sort())
  })
})
function stream(text: string): string {
  return (
    (text ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` : '') +
    `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`
  )
}
describe('server-owned AI', () => {
  const secret = 'sk-test-secret-never-in-response'
  async function chat() {
    await enrolled()
    expect((await call('PUT', '/me/ai', { key: secret })).body).not.toContain(secret)
    return (await call('POST', '/learning/chats', { kind: 'course', id, version: '1.0.0' })).json().chat.id as string
  }
  it('persists enabled models and uses composer overrides without changing account defaults', async () => {
    const chatId = await chat()
    expect((await call('PUT', '/me/ai', { model: 'gpt-4.1-mini', enabledModels: ['gpt-4.1-mini', 'gpt-5.1'] })).json().enabledModels).toEqual(['gpt-4.1-mini', 'gpt-5.1'])
    const requests: any[] = []
    server.ctx.aiFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body)
      return new Response(stream(body.instructions === TITLE_INSTRUCTIONS ? '' : 'Answer'))
    }
    const body = { text: 'Explain this', quote: 'A selected passage', model: 'gpt-5.1', reasoning: 'high', requestId: 'override' }
    expect((await call('POST', `/learning/chats/${chatId}/messages`, body)).statusCode).toBe(200)
    await vi.waitFor(async () => expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).status).toBe('complete'))
    expect(requests[0]).toMatchObject({ model: 'gpt-5.1', reasoning: { effort: 'high' } })
    expect(JSON.stringify(requests[0].input)).toContain('A selected passage')
    const messages = (await call('GET', `/learning/chats/${chatId}`)).json().messages
    expect(messages[0]).toMatchObject({ text: 'Explain this', quote: 'A selected passage' })
    expect(messages[1]).toMatchObject({ model: 'gpt-5.1', reasoning: 'high' })
    expect((await call('GET', '/me/ai')).json()).toMatchObject({ model: 'gpt-4.1-mini', reasoning: null })
    expect((await call('POST', `/learning/chats/${chatId}/messages`, { ...body, model: 'gpt-5-mini', requestId: 'disabled' })).statusCode).toBe(400)
    expect((await call('PUT', '/me/ai', { enabledModels: ['gpt-5.1'] })).statusCode).toBe(400)
    expect((await call('PUT', '/me/ai', { enabledModels: ['bad model'] })).statusCode).toBe(400)
    await call('PUT', '/me/ai', { enabledModels: [] })
    expect((await call('POST', `/learning/chats/${chatId}/messages`, { text: 'Question', requestId: 'empty' })).statusCode).toBe(400)
  })
  it('exposes tool activity while streaming and preserves web citation offsets', async () => {
    const chatId = await chat()
    let finish!: () => void
    server.ctx.aiFetch = async (_url, init) => {
      if (JSON.parse(String(init?.body)).instructions === TITLE_INSTRUCTIONS) return new Response(stream(''))
      return new Response(new ReadableStream({ start(controller) {
        const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        emit({ type: 'response.web_search_call.searching' })
        finish = () => {
          emit({ type: 'response.output_text.delta', delta: 'An answer.' })
          emit({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Reference', start_index: 0, end_index: 10 }] }] }] } })
          controller.close()
        }
      } }))
    }
    await call('POST', `/learning/chats/${chatId}/messages`, { text: 'Find a reference', requestId: 'activity' })
    await vi.waitFor(async () => expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).activity).toEqual({ label: 'Searching the web', running: true }))
    finish()
    await vi.waitFor(async () => expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).status).toBe('complete'))
    const answer = (await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1)
    expect(answer.activity.running).toBe(false)
    expect(answer.citations).toEqual([{ title: 'Reference', url: 'https://example.com', start: 0, end: 10 }])
  })
  it('encrypts credentials with account binding and rotates envelopes', async () => {
    await call('PUT', '/me/ai', { key: secret })
    const stored = server.ctx.db.prepare('SELECT * FROM learning_ai').get()!
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(readAIKey(server.ctx, account)).toBe(secret)
    server.ctx.config.aiEncryptionKeys = JSON.stringify({ first: 'ab'.repeat(32), second: 'cd'.repeat(32) })
    server.ctx.config.aiActiveKey = 'second'
    expect(readAIKey(server.ctx, account)).toBe(secret)
    expect(String(server.ctx.db.prepare('SELECT secret FROM learning_ai').get()!.secret)).toContain('second')
  })
  it('persists streamed answers once, replays SSE and prevents cross-account reads', async () => {
    const chatId = await chat()
    let requests = 0
    server.ctx.aiFetch = async (_url, init) => {
      // Naming the chat is its own request, and this one names nothing usable.
      if (JSON.parse(String(init?.body)).instructions === TITLE_INSTRUCTIONS) return new Response(stream(''))
      requests++
      return new Response(
        'data: ' +
          JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello learner' }) +
          '\n\ndata: ' +
          JSON.stringify({ type: 'response.completed', response: { output: [] } }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const body = { text: 'Explain SSA', requestId: 'same-send' }
    const sent = await call('POST', `/learning/chats/${chatId}/messages`, body)
    expect(sent.statusCode, sent.body).toBe(200)
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).status).toBe('complete')
    )
    await call('POST', `/learning/chats/${chatId}/messages`, body)
    expect(requests).toBe(1)
    expect((await call('GET', `/learning/chats/${chatId}/events`)).body).toContain('Hello learner')
    expect((await call('GET', '/learning/chats?kind=course&id=' + id)).json().chats[0]).toMatchObject({
      title: 'Explain SSA', messages: 2, running: false
    })
    const other = await signUp(server)
    expect((await call('GET', `/learning/chats/${chatId}`, undefined, other.token)).statusCode).toBe(404)
    expect((await call('DELETE', `/learning/chats/${chatId}`, undefined, other.token)).statusCode).toBe(404)
    expect((await call('GET', '/sync')).body).not.toContain(secret)
    expect((await call('DELETE', `/learning/chats/${chatId}`)).statusCode).toBe(200)
    expect((await call('GET', `/learning/chats/${chatId}`)).statusCode).toBe(404)
    expect((await call('GET', '/learning/chats?kind=course&id=' + id)).json().chats).toEqual([])
    expect(server.ctx.db.prepare('SELECT id FROM learning_messages WHERE chat_id=?').all(chatId)).toEqual([])
    const feed = (await call('GET', '/sync')).json()
    expect(feed.changes.filter((c: { type: string; key: string }) => c.type === 'chat' && c.key === chatId))
      .toEqual([expect.objectContaining({ value: { deleted: true } })])
  })
  it('keeps a model and reasoning level per activity, dropping a level the model cannot take', async () => {
    expect((await call('GET', '/me/ai')).json()).toMatchObject({ model: 'gpt-4.1-mini', reasoning: null, title: null })
    const set = await call('PUT', '/me/ai', {
      model: 'gpt-5.1',
      reasoning: 'high',
      title: { model: 'gpt-5-mini', reasoning: 'minimal' }
    })
    expect(set.json()).toMatchObject({
      model: 'gpt-5.1',
      reasoning: 'high',
      title: { model: 'gpt-5-mini', reasoning: 'minimal' }
    })
    // gpt-4.1 takes no level; the title is a separate choice and stays.
    expect((await call('PUT', '/me/ai', { model: 'gpt-4.1-mini' })).json()).toMatchObject({
      model: 'gpt-4.1-mini',
      reasoning: null,
      title: { model: 'gpt-5-mini', reasoning: 'minimal' }
    })
    // 5.1 has no `minimal`: stored as the model's default rather than refused later by OpenAI.
    expect((await call('PUT', '/me/ai', { title: { model: 'gpt-5.1', reasoning: 'minimal' } })).json().title).toEqual({
      model: 'gpt-5.1',
      reasoning: null
    })
    expect((await call('PUT', '/me/ai', { reasoning: 'maximum' })).statusCode).toBe(400)
    expect((await call('PUT', '/me/ai', { title: { model: 'bad model' } })).statusCode).toBe(400)
    expect((await call('PUT', '/me/ai', { title: null })).json().title).toBeNull()
  })
  it('answers with the chat defaults and names the conversation with the title defaults', async () => {
    const chatId = await chat()
    await call('PUT', '/me/ai', {
      model: 'gpt-5.1',
      reasoning: 'high',
      webSearch: true,
      title: { model: 'gpt-5-mini', reasoning: 'low' }
    })
    const bodies: Record<string, unknown>[] = []
    server.ctx.aiFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return new Response(stream(body.instructions === TITLE_INSTRUCTIONS ? 'Static single assignment' : 'An answer'))
    }
    await call('POST', `/learning/chats/${chatId}/messages`, { text: 'What is SSA form?', requestId: 'named' })
    await vi.waitFor(async () =>
      expect((await call('GET', '/learning/chats?kind=course&id=' + id)).json().chats[0].title).toBe(
        'Static single assignment'
      )
    )
    const [answer, title] = bodies
    expect(answer).toMatchObject({ model: 'gpt-5.1', reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'] })
    expect(answer.tools).toContainEqual({ type: 'web_search' })
    expect(title).toMatchObject({ model: 'gpt-5-mini', reasoning: { effort: 'low' }, store: false })
    expect(title.tools).toBeUndefined()
    expect(JSON.stringify(title.input)).toContain('What is SSA form?')
    expect(JSON.stringify(title.input)).not.toContain('An answer')
    // Named once: a second answer does not ask again.
    await call('POST', `/learning/chats/${chatId}/messages`, { text: 'And phi nodes?', requestId: 'second' })
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).status).toBe('complete')
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(bodies.filter((b) => b.instructions === TITLE_INSTRUCTIONS)).toHaveLength(1)
  })
  it('names a chat with its own model at low reasoning when no title model is chosen', async () => {
    const chatId = await chat()
    await call('PUT', '/me/ai', { model: 'gpt-4.1-mini', webSearch: true })
    const bodies: Record<string, unknown>[] = []
    server.ctx.aiFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return new Response(stream(body.instructions === TITLE_INSTRUCTIONS ? 'Reading about SSA' : 'An answer'))
    }
    await call('POST', `/learning/chats/${chatId}/messages`, { text: 'Explain SSA', requestId: 'default-title' })
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chatId}`)).json().chat.title).toBe('Reading about SSA')
    )
    expect(bodies[0].reasoning).toBeUndefined()
    expect(bodies[0].include).toBeUndefined()
    expect(bodies[1]).toMatchObject({ model: 'gpt-4.1-mini' })
    // gpt-4.1 takes no level, so none is sent.
    expect(bodies[1].reasoning).toBeUndefined()
    await call('PUT', '/me/ai', { model: 'gpt-5.1' })
    expect((await call('GET', '/me/ai')).json().title).toBeNull()
  })
  it('lists the key’s chat models, and the curated list when there is no answer', async () => {
    expect((await call('GET', '/me/ai/models')).json()).toEqual({ source: 'fallback', models: [] })
    await call('PUT', '/me/ai', { key: secret })
    const seen: string[] = []
    server.ctx.aiFetch = async (url, init) => {
      seen.push(String(url))
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
      return Response.json({ data: [{ id: 'gpt-5.1' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4.1-mini' }] })
    }
    const listed = await call('GET', '/me/ai/models')
    expect(listed.json()).toEqual({
      source: 'api',
      models: [
        { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
        { id: 'gpt-5.1', label: 'gpt-5.1' }
      ]
    })
    expect(seen).toEqual(['https://api.openai.com/v1/models'])
    server.ctx.aiFetch = async () => new Response(secret, { status: 401 })
    const refused = await call('GET', '/me/ai/models')
    expect(refused.json()).toMatchObject({ source: 'fallback', error: expect.stringContaining('rejected') })
    expect(refused.body).not.toContain(secret)
    server.ctx.config.aiEncryptionKeys = undefined
    expect((await call('GET', '/me/ai/models')).json()).toEqual({ source: 'fallback', models: [] })
  })
  it('sanitizes provider failures and never switches credentials', async () => {
    const chatId = await chat()
    let requests = 0
    server.ctx.aiFetch = async () => {
      requests++
      return new Response(secret, { status: 401 })
    }
    await call('POST', `/learning/chats/${chatId}/messages`, { text: 'Explain', requestId: 'failure' })
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chatId}`)).json().messages.at(-1).status).toBe('error')
    )
    const result = await call('GET', `/learning/chats/${chatId}`)
    expect(result.body).not.toContain(secret)
    expect(result.body).toContain('rejected')
    expect(requests).toBe(1)
  })
})

describe('AI recovery and tool boundaries', () => {
  async function setup() {
    await enrolled()
    await call('PUT', '/me/ai', { key: 'sk-test' })
    return (await call('POST', '/learning/chats', { kind: 'course', id, version: '1.0.0' })).json().chat.id as string
  }
  it('filters answers in tool results, preserves citations and scopes tools to the conversation', async () => {
    const chat = await setup(),
      requests: Record<string, unknown>[] = []
    server.ctx.aiFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.instructions === TITLE_INSTRUCTIONS) return new Response(stream(''))
      requests.push(body)
      const output =
        requests.length === 1
          ? [
              {
                type: 'function_call',
                name: 'read_course_section',
                arguments: JSON.stringify({ module_id: fixtureModule(), lesson_id: lesson, offset: 0 }),
                call_id: 'read'
              }
            ]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SSA is assigned once.' }] }]
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`)
    }
    function fixtureModule() {
      return (server.ctx.db.prepare('SELECT parent FROM elements WHERE uid=?').get(lesson) as { parent: string }).parent
    }
    await call('POST', `/learning/chats/${chat}/messages`, { text: 'Explain the lesson', requestId: 'tools' })
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chat}`)).json().messages.at(-1).status).toBe('complete')
    )
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).not.toMatch(/SECRET-(EXPLANATION|SOLUTION|OUTPUT|ANSWER)/)
    expect(JSON.stringify(requests[0].tools)).not.toMatch(/shell|write_file/)
    expect((await call('GET', `/learning/chats/${chat}`)).json().messages.at(-1).citations[0].lessonId).toBe(lesson)
  })
  it('cancels active requests and closes the provider before closing the database', async () => {
    const chat = await setup()
    let calls = 0
    server.ctx.aiFetch = async (_url, init) => {
      calls++
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
          }
        })
      )
    }
    await call('POST', `/learning/chats/${chat}/messages`, { text: 'Explain', requestId: 'cancel' })
    await vi.waitFor(() => expect(calls).toBe(1))
    expect(
      (await call('POST', `/learning/chats/${chat}/messages`, { text: 'Again', requestId: 'other' })).statusCode
    ).toBe(409)
    await call('POST', `/learning/chats/${chat}/cancel`, {})
    await vi.waitFor(async () =>
      expect((await call('GET', `/learning/chats/${chat}`)).json().messages.at(-1).status).toBe('cancelled')
    )
    await call('POST', `/learning/chats/${chat}/messages`, { text: 'Shutdown', requestId: 'shutdown' })
    await vi.waitFor(() => expect(calls).toBe(2))
    await server.app.close()
  })
  it('deletes a running conversation without leaving messages or stream events behind', async () => {
    const chat = await setup()
    let aborted = false, started = false
    server.ctx.aiFetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        started = true
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          controller.error(new Error('aborted'))
        }, { once: true })
      }
    }))
    await call('POST', `/learning/chats/${chat}/messages`, { text: 'Explain', requestId: 'delete-running' })
    await vi.waitFor(() => expect(started).toBe(true))
    expect((await call('DELETE', `/learning/chats/${chat}`)).statusCode).toBe(200)
    expect(aborted).toBe(true)
    expect((await call('GET', `/learning/chats/${chat}`)).statusCode).toBe(404)
    expect(server.ctx.db.prepare('SELECT id FROM learning_messages WHERE chat_id=?').all(chat)).toEqual([])
    expect(server.ctx.db.prepare('SELECT id FROM learning_stream').all()).toEqual([])
  })
  it('imports legacy reading conversations idempotently with versioned history', async () => {
    await enrolled()
    const body = {
      kind: 'course',
      id,
      version: '1.0.0',
      importId: 'legacy:one',
      title: 'Previous reading',
      messages: [
        { role: 'user', text: 'Explain this', at: '2026-01-01T00:00:00Z' },
        { role: 'assistant', text: 'Old answer', at: '2026-01-01T00:00:01Z' }
      ]
    }
    const first = await call('POST', '/learning/chats/import', body),
      second = await call('POST', '/learning/chats/import', body)
    expect(first.statusCode, first.body).toBe(200)
    expect(second.json().chat.id).toBe(first.json().chat.id)
    expect(second.json().messages).toHaveLength(2)
    expect((await call('GET', '/sync')).body).toContain('Old answer')
  })
})

describe('learning lifecycle boundaries', () => {
  it('keeps identity and conversations across restart, without restarting billable generations', async () => {
    await enrolled()
    const stable = (await call('GET', '/server')).json().id
    const chat = (await call('POST', '/learning/chats', { kind: 'course', id, version: '1.0.0' })).json().chat.id
    server.ctx.db
      .prepare(
        "INSERT INTO learning_messages(id,chat_id,role,text,status,at) VALUES(?,?,'assistant','Partial','running',?)"
      )
      .run(randomUUID(), chat, new Date().toISOString())
    const config = server.ctx.config
    await server.app.close()
    const restarted = await buildApp({
      config,
      mailer: server.outbox,
      logger: false,
      aiFetch: async () => {
        throw new Error('Must not call provider')
      }
    })
    try {
      expect((await restarted.app.inject({ url: '/api/v1/server' })).json().id).toBe(stable)
      const messages = (
        await restarted.app.inject({ url: `/api/v1/learning/chats/${chat}`, headers: auth(token) })
      ).json().messages
      expect(messages[0]).toMatchObject({ text: 'Partial', status: 'interrupted' })
      expect((await restarted.app.inject({ url: '/api/v1/sync', headers: auth(token) })).body).toContain('interrupted')
    } finally {
      await restarted.app.close()
    }
  })
  it('requires lesson completion for web reviews and deduplicates ratings', async () => {
    const s = await enrolled(),
      base = `/learn/course/${id}/1.0.0/cards/${card}`
    expect((await call('POST', `${base}/reveal`, {})).statusCode).toBe(400)
    await push(operation(s, `lesson:${lesson}`, true))
    expect((await call('POST', `${base}/reveal`, {})).json().answer).toBe('SECRET-ANSWER')
    const rating = { rating: 'good', requestId: 'one-review' }
    expect((await call('POST', `${base}/rate`, rating)).statusCode).toBe(200)
    await call('POST', `${base}/rate`, rating)
    expect(((await current()).fields[`review:${card}`].value as { card: { reps: number } }).card.reps).toBe(1)
  })
  it('retains document access after unpublishing and history after version deletion', async () => {
    const doc = randomUUID()
    expect((await publishPdf(doc)).statusCode).toBe(201)
    const s = (await call('PUT', `/me/learning/document/${doc}`, {})).json() as LearningState
    await push({ ...operation(s, 'readPage', 1), kind: 'document', id: doc })
    expect((await call('DELETE', `/documents/${doc}`)).statusCode).toBe(200)
    expect((await call('GET', `/learn/document/${doc}/1.0.0/pdf`)).statusCode).toBe(200)
    const other = await signUp(server)
    expect((await call('PUT', `/me/learning/document/${doc}`, {}, other.token)).statusCode).toBe(404)
    expect((await call('DELETE', `/documents/${doc}/versions/1.0.0`)).statusCode).toBe(200)
    expect((await call('GET', `/learn/document/${doc}/1.0.0/pdf`)).statusCode).toBe(404)
    expect((await call('GET', '/me/learning')).json().items[0].fields.readPage.value).toBe(1)
  })
})
