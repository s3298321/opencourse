import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auth, lastCode, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => server.app.inject({ method: 'POST', url, payload: payload as object, headers })

describe('sign-up by email code', () => {
  it('confirms the address, checks the name, sets the password and signs in', async () => {
    const email = 'ada@example.org'
    expect((await post('/api/v1/auth/register/start', { email })).statusCode).toBe(202)
    const code = lastCode(server.outbox, email)
    const wrong = await post('/api/v1/auth/register/verify', { email, code: code === '000000' ? '111111' : '000000' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error).toMatchObject({ code: 'invalid_code', attemptsLeft: 4 })
    const verified = await post('/api/v1/auth/register/verify', { email, code })
    expect(verified.statusCode).toBe(200)
    const { ticket } = verified.json()

    const check = async (name: string) => (await server.app.inject({ method: 'GET', url: `/api/v1/auth/username?name=${name}` })).json()
    expect(await check('ad')).toMatchObject({ available: false })
    expect(await check('admin')).toMatchObject({ available: false, reason: 'That name is reserved.' })
    expect(await check('Ada')).toMatchObject({ available: false })
    expect(await check('ada')).toEqual({ available: true })

    expect((await post('/api/v1/auth/register/complete', { ticket, username: 'ada', password: 'short' })).json().error.code).toBe('weak_password')
    const done = await post('/api/v1/auth/register/complete', { ticket, username: 'ada', password: 'a long enough password' })
    expect(done.statusCode).toBe(201)
    const { token, account } = done.json()
    expect(token).toMatch(/^ocs_/)
    expect(account).toMatchObject({ username: 'ada', email })
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(token) })).json().account.username).toBe('ada')
    // The ticket is spent; the database keeps no token in the clear.
    expect((await post('/api/v1/auth/register/complete', { ticket, username: 'ada2', password: 'a long enough password' })).json().error.code).toBe('invalid_ticket')
    expect(JSON.stringify(server.ctx.db.prepare('SELECT * FROM sessions').all())).not.toContain(token)
    expect(JSON.stringify(server.ctx.db.prepare('SELECT * FROM email_codes').all())).not.toContain(code)
  })

  it('says nothing about whether an address already has an account', async () => {
    const existing = await signUp(server, 'grace')
    const again = await post('/api/v1/auth/register/start', { email: existing.email })
    expect(again.statusCode).toBe(202)
    const mail = server.outbox.messages.at(-1)!
    expect(mail.subject).toContain('already have an account')
    expect(mail.text).not.toMatch(/\b\d{6}\b/)
    expect((await post('/api/v1/auth/password/forgot', { email: 'nobody@example.org' })).statusCode).toBe(202)
  })

  it('refuses a name that is taken, and a code tried too often or too late', async () => {
    await signUp(server, 'taken')
    const email = 'second@example.org'
    await post('/api/v1/auth/register/start', { email })
    const code = lastCode(server.outbox, email)
    for (let i = 0; i < 5; i++) await post('/api/v1/auth/register/verify', { email, code: code === '999999' ? '999998' : '999999' })
    expect((await post('/api/v1/auth/register/verify', { email, code })).json().error).toMatchObject({ code: 'invalid_code', attemptsLeft: 0 })

    // A fresh code (after the per-address window) can expire, too.
    server.ctx.db.prepare('DELETE FROM email_codes').run()
    const third = 'third@example.org'
    await post('/api/v1/auth/register/start', { email: third })
    server.ctx.db.prepare("UPDATE email_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    expect((await post('/api/v1/auth/register/verify', { email: third, code: lastCode(server.outbox, third) })).statusCode).toBe(400)

    await post('/api/v1/auth/register/start', { email: 'fourth@example.org' })
    const ticket = (await post('/api/v1/auth/register/verify', { email: 'fourth@example.org', code: lastCode(server.outbox, 'fourth@example.org') })).json().ticket
    const clash = await post('/api/v1/auth/register/complete', { ticket, username: 'TAKEN', password: 'a long enough password' })
    expect(clash.json().error.code).toBe('invalid_username')
    expect((await post('/api/v1/auth/register/complete', { ticket, username: 'taken', password: 'a long enough password' })).json().error.code).toBe('username_taken')
  })

  it('limits how often one address can be sent a code', async () => {
    const email = 'flood@example.org'
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await post('/api/v1/auth/register/start', { email })).statusCode)
    expect(statuses).toEqual([202, 202, 202, 429])
  })

  it('can be closed by the operator', async () => {
    await server.close()
    server = await testServer({ registration: 'closed' })
    expect((await post('/api/v1/auth/register/start', { email: 'x@example.org' })).json().error.code).toBe('registration_closed')
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/server' })).json()).toMatchObject({ opencourse: 1, api: 1, registration: 'closed' })
  })
})

describe('signing in and out', () => {
  it('accepts the email or the username, with one message for every failure', async () => {
    const user = await signUp(server, 'lin')
    for (const login of ['lin', user.email, 'LIN']) expect((await post('/api/v1/auth/login', { login, password: 'correct horse battery' })).statusCode).toBe(200)
    const wrong = await post('/api/v1/auth/login', { login: 'lin', password: 'wrong password' })
    const missing = await post('/api/v1/auth/login', { login: 'nobody', password: 'wrong password' })
    expect(wrong.statusCode).toBe(401); expect(missing.statusCode).toBe(401)
    expect(wrong.json().error.message).toBe(missing.json().error.message)
  })

  it('revokes a token on logout, and every token on a password reset', async () => {
    const user = await signUp(server, 'moe')
    const other = (await post('/api/v1/auth/login', { login: 'moe', password: 'correct horse battery' })).json().token
    expect((await post('/api/v1/auth/logout', {}, auth(user.token))).statusCode).toBe(204)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(user.token) })).statusCode).toBe(401)

    await post('/api/v1/auth/password/forgot', { email: user.email })
    const reset = await post('/api/v1/auth/password/reset', { email: user.email, code: lastCode(server.outbox, user.email), password: 'a brand new password' })
    expect(reset.statusCode).toBe(200)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(other) })).statusCode).toBe(401)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(reset.json().token) })).statusCode).toBe(200)
    expect((await post('/api/v1/auth/login', { login: 'moe', password: 'correct horse battery' })).statusCode).toBe(401)
    expect((await post('/api/v1/auth/login', { login: 'moe', password: 'a brand new password' })).statusCode).toBe(200)
  })

  it('refuses a disabled account and its sessions', async () => {
    const user = await signUp(server, 'banned')
    server.ctx.db.prepare("UPDATE accounts SET disabled_at = '2026-01-01' WHERE id = ?").run(user.id)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(user.token) })).statusCode).toBe(401)
    expect((await post('/api/v1/auth/login', { login: 'banned', password: 'correct horse battery' })).json().error.code).toBe('account_disabled')
  })
})
