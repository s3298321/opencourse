/** Explicit, billable release check against a disposable server. Never logs keys or model output. */
import { randomBytes } from 'node:crypto'
import { testServer, signUp, localCourse, publish, auth } from '../tests/helpers'

const key = process.env.OPENCOURSE_AI_SMOKE_KEY
if (!key) throw new Error('Set OPENCOURSE_AI_SMOKE_KEY to opt in to one controlled, billable API smoke check.')
const server = await testServer({
  webDir: null,
  aiEncryptionKeys: JSON.stringify({ smoke: randomBytes(32).toString('hex') }),
  aiActiveKey: 'smoke'
})
try {
  const account = await signUp(server)
  const fixture = localCourse()
  const request = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => {
    const result = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: auth(account.token),
      ...(payload === undefined ? {} : { payload: payload as object })
    })
    if (result.statusCode >= 400) throw new Error(`Smoke request failed: ${method} ${path} (${result.statusCode})`)
    return result.json()
  }
  const published = await publish(server, account.token, fixture.courseId, fixture.local, '1.0.0')
  if (published.statusCode !== 201) throw new Error('Smoke fixture could not be published.')
  await request('PUT', `/me/learning/course/${fixture.courseId}`, {})
  await request('PUT', '/me/ai', {
    key,
    model: process.env.OPENCOURSE_AI_SMOKE_MODEL ?? 'gpt-4.1-mini',
    webSearch: false
  })
  const chat = await request('POST', '/learning/chats', { kind: 'course', id: fixture.courseId, version: '1.0.0' })
  let calls = 0
  server.ctx.aiFetch = async (url, init) => {
    if (++calls > 2) throw new Error('Controlled smoke provider request limit reached.')
    return fetch(url, init)
  }
  await request('POST', `/learning/chats/${chat.chat.id}/messages`, {
    text: 'Reply with the single word OK. Do not call any tools.',
    requestId: 'controlled-smoke'
  })
  const deadline = Date.now() + 125000
  while (Date.now() < deadline) {
    const view = await request('GET', `/learning/chats/${chat.chat.id}`)
    const message = view.messages.at(-1)
    if (message?.status === 'complete' && message.text.trim()) {
      console.log(`Server AI smoke passed (${calls} provider request${calls === 1 ? '' : 's'}).`)
      break
    }
    if (message?.status !== 'running')
      throw new Error(`AI smoke ended with status ${message?.status}. Check provider access and quota.`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const final = await request('GET', `/learning/chats/${chat.chat.id}`)
  if (final.messages.at(-1)?.status !== 'complete') throw new Error('AI smoke timed out.')
} finally {
  await server.close()
}
