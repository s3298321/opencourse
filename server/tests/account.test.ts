import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auth, lastCode, localCourse, publish, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const PASSWORD = 'correct horse battery'
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: object) =>
  server.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) })
const login = async (name: string, password = PASSWORD): Promise<string> => {
  const response = await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password } })
  return response.statusCode === 200 ? response.json().token : ''
}

describe('your account', () => {
  it('shows the account with its role and when it was made', async () => {
    const ada = await signUp(server, 'ada')
    const { account } = (await call('GET', '/api/v1/me', ada.token)).json()
    expect(account).toMatchObject({ id: ada.id, username: 'ada', email: ada.email, role: 'member' })
    expect(Date.parse(account.createdAt)).not.toBeNaN()
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401)
  })

  it('changes the password only with the current one, keeping this session and ending the others', async () => {
    const ada = await signUp(server, 'ada')
    const other = await login('ada')
    expect((await call('POST', '/api/v1/me/password', ada.token, { current: 'wrong password', password: 'a brand new password' })).statusCode).toBe(401)
    expect((await call('POST', '/api/v1/me/password', ada.token, { current: PASSWORD, password: 'short' })).json().error.code).toBe('weak_password')
    expect((await call('POST', '/api/v1/me/password', ada.token, { current: PASSWORD, password: 'a brand new password' })).statusCode).toBe(200)
    expect((await call('GET', '/api/v1/me', ada.token)).statusCode).toBe(200)
    expect((await call('GET', '/api/v1/me', other)).statusCode).toBe(401)
    expect(await login('ada')).toBe('')
    expect(await login('ada', 'a brand new password')).toMatch(/^ocs_/)
    expect(server.outbox.messages.at(-1)).toMatchObject({ to: ada.email, subject: expect.stringContaining('password was changed') })
  })

  it('moves to a new address once the new address confirms it, and tells the old one', async () => {
    const ada = await signUp(server, 'ada')
    const taken = await signUp(server, 'taken')
    expect((await call('POST', '/api/v1/me/email/start', ada.token, { email: 'new@example.org', password: 'nope nope nope' })).statusCode).toBe(401)
    expect((await call('POST', '/api/v1/me/email/start', ada.token, { email: 'new@example.org', password: PASSWORD })).statusCode).toBe(202)
    const code = lastCode(server.outbox, 'new@example.org')

    // Another account cannot spend a code that was mailed for this one.
    const thief = await signUp(server, 'thief')
    expect((await call('POST', '/api/v1/me/email/verify', thief.token, { email: 'new@example.org', code })).json().error.code).toBe('invalid_code')

    const done = await call('POST', '/api/v1/me/email/verify', ada.token, { email: 'new@example.org', code })
    expect(done.statusCode).toBe(200)
    expect(done.json().account.email).toBe('new@example.org')
    expect(server.outbox.messages.at(-1)).toMatchObject({ to: ada.email, subject: expect.stringContaining('address was changed') })
    expect(await login('new@example.org')).toMatch(/^ocs_/)

    // An address with an account gets a note, never a code - and the answer is the same.
    const before = server.outbox.messages.length
    expect((await call('POST', '/api/v1/me/email/start', ada.token, { email: taken.email, password: PASSWORD })).statusCode).toBe(202)
    const note = server.outbox.messages.slice(before).find((m) => m.to === taken.email)!
    expect(note.text).not.toMatch(/\b\d{6}\b/)
  })

  it('lists sessions and ends one, or all but this one', async () => {
    const ada = await signUp(server, 'ada')
    const second = await login('ada'), third = await login('ada')
    const list = (await call('GET', '/api/v1/me/sessions', ada.token)).json().sessions as { id: string; current: boolean }[]
    expect(list).toHaveLength(3)
    expect(list.filter((s) => s.current)).toHaveLength(1)
    const secondId = (await call('GET', '/api/v1/me/sessions', second)).json().sessions.find((s: { current: boolean }) => s.current).id
    expect((await call('DELETE', `/api/v1/me/sessions/${secondId}`, ada.token)).statusCode).toBe(204)
    expect((await call('GET', '/api/v1/me', second)).statusCode).toBe(401)
    expect((await call('DELETE', `/api/v1/me/sessions/${secondId}`, ada.token)).statusCode).toBe(404)
    // Someone else's session id is not one of yours.
    const other = await signUp(server, 'other')
    const otherId = (await call('GET', '/api/v1/me/sessions', other.token)).json().sessions[0].id
    expect((await call('DELETE', `/api/v1/me/sessions/${otherId}`, ada.token)).statusCode).toBe(404)

    expect((await call('POST', '/api/v1/me/sessions/revoke-others', ada.token)).statusCode).toBe(200)
    expect((await call('GET', '/api/v1/me', third)).statusCode).toBe(401)
    expect((await call('GET', '/api/v1/me/sessions', ada.token)).json().sessions).toHaveLength(1)
  })

  it('deletes the account with its courses, archives and covers', async () => {
    const author = await signUp(server, 'author')
    const learner = await signUp(server, 'learner')
    const { courseId, local } = localCourse()
    expect((await publish(server, author.token, courseId, local, '0.1.0')).statusCode).toBe(201)
    await server.app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/download`, headers: auth(learner.token), payload: { intent: 'add' } })
    const archives = join(server.ctx.config.dataDir, 'archives', courseId)
    expect(existsSync(archives)).toBe(true)

    expect((await call('DELETE', '/api/v1/me', author.token, { password: 'wrong wrong wrong' })).statusCode).toBe(401)
    expect((await call('DELETE', '/api/v1/me', author.token, { password: PASSWORD })).statusCode).toBe(204)
    expect(existsSync(archives)).toBe(false)
    expect((await call('GET', '/api/v1/me', author.token)).statusCode).toBe(401)
    expect(await login('author')).toBe('')
    expect((await server.app.inject({ method: 'GET', url: `/api/v1/courses/${courseId}` })).statusCode).toBe(404)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/courses?q=llvm' })).json().total).toBe(0)
    // The learner is untouched, and the name is free again.
    expect((await call('GET', '/api/v1/me', learner.token)).statusCode).toBe(200)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/username?name=author' })).json()).toEqual({ available: true })
  })
})
