import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auth, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const PASSWORD = 'correct horse battery'

async function webSignIn(target: TestServer, login: string): Promise<{ token: string; body: Record<string, unknown>; setCookie: string }> {
  const response = await target.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: PASSWORD, session: 'cookie' } })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies.find((c) => c.name.endsWith('ocs_session'))!
  return { token: cookie.value, body: response.json(), setCookie: String(response.headers['set-cookie']) }
}

describe('the web app\'s cookie session', () => {
  it('puts the token in an HttpOnly cookie and never in the body', async () => {
    const ada = await signUp(server, 'ada')
    const { token, body, setCookie } = await webSignIn(server, 'ada')
    expect(token).toMatch(/^ocs_/)
    expect(JSON.stringify(body)).not.toContain('ocs_')
    expect(body).toMatchObject({ account: { id: ada.id, username: 'ada', role: 'member' } })
    expect(setCookie).toMatch(/^ocs_session=/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    // Plain http (a development server): no Secure, which the browser would refuse there.
    expect(setCookie).not.toContain('Secure')

    const me = await server.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { ocs_session: token } })
    expect(me.json().account).toMatchObject({ username: 'ada', role: 'member' })
    const sessions = await server.app.inject({ method: 'GET', url: '/api/v1/me/sessions', cookies: { ocs_session: token } })
    expect(sessions.json().sessions.filter((s: { kind: string }) => s.kind === 'web')).toHaveLength(1)
  })

  it('is Secure and host-only on an https server', async () => {
    const secure = await testServer({ publicUrl: 'https://catalog.example.org' })
    try {
      await signUp(secure, 'grace')
      const response = await secure.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'grace', password: PASSWORD, session: 'cookie' } })
      const setCookie = String(response.headers['set-cookie'])
      expect(setCookie).toMatch(/^__Host-ocs_session=/)
      expect(setCookie).toContain('Secure')
      expect(setCookie).not.toContain('Domain=')
    } finally { await secure.close() }
  })

  it('refuses a change that did not come from this site', async () => {
    await signUp(server, 'lin')
    const { token } = await webSignIn(server, 'lin')
    const revoke = (headers: Record<string, string>) => server.app.inject({ method: 'POST', url: '/api/v1/me/sessions/revoke-others', cookies: { ocs_session: token }, headers })
    expect((await revoke({})).statusCode).toBe(403)
    expect((await revoke({ 'sec-fetch-site': 'cross-site' })).json().error.code).toBe('cross_site')
    expect((await revoke({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403)
    expect((await revoke({ origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await revoke({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200)
    expect((await revoke({ origin: 'http://127.0.0.1:8787' })).statusCode).toBe(200)
    // Reading needs no such proof: a cross-site page cannot read the answer anyway.
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { ocs_session: token } })).statusCode).toBe(200)
  })

  it('leaves the app\'s Bearer token exactly as it was', async () => {
    const app = await signUp(server, 'appuser')
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/me/sessions/revoke-others', headers: { ...auth(app.token), 'sec-fetch-site': 'cross-site' } })
    expect(response.statusCode).toBe(200)
    const login = await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'appuser', password: PASSWORD } })
    expect(login.json().token).toMatch(/^ocs_/)
    expect(login.headers['set-cookie']).toBeUndefined()
  })

  it('signs out by clearing the cookie and ending the session', async () => {
    await signUp(server, 'moe')
    const { token } = await webSignIn(server, 'moe')
    const out = await server.app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { ocs_session: token }, headers: { 'sec-fetch-site': 'same-origin' } })
    expect(out.statusCode).toBe(204)
    expect(String(out.headers['set-cookie'])).toMatch(/ocs_session=;.*Expires=Thu, 01 Jan 1970/)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { ocs_session: token } })).statusCode).toBe(401)
  })

  it('names the session by its user agent, and marks the current one', async () => {
    const user = await signUp(server, 'kit')
    await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'kit', password: PASSWORD, session: 'cookie' }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' } })
    const list = (await server.app.inject({ method: 'GET', url: '/api/v1/me/sessions', headers: auth(user.token) })).json().sessions as { kind: string; userAgent: string; current: boolean }[]
    expect(list).toHaveLength(2)
    expect(list.find((s) => s.kind === 'web')).toMatchObject({ userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', current: false })
    expect(list.find((s) => s.current)?.kind).toBe('app')
    expect(JSON.stringify(list)).not.toMatch(/ocs_|token_hash/)
  })
})
