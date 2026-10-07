import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setRole } from '../src/admin/routes'
import { auth, localCourse, publish, signUp, testServer, type TestServer } from './helpers'

let server: TestServer
beforeEach(async () => { server = await testServer() })
afterEach(async () => { await server.close() })

const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: object) =>
  server.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) })

/** The first administrator is made on the server's machine, as `npm run admin -- grant-admin` does. */
async function admin(name = 'root-admin'): Promise<{ token: string; id: string }> {
  const account = await signUp(server, name)
  setRole(server.ctx.db, null, account.id, 'admin')
  return account
}

describe('the admin console', () => {
  it('is for administrators only', async () => {
    const member = await signUp(server, 'member')
    for (const url of ['/api/v1/admin/stats', '/api/v1/admin/accounts', '/api/v1/admin/courses', '/api/v1/admin/audit']) {
      expect((await call('GET', url, member.token)).json().error.code).toBe('not_admin')
      expect((await server.app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
    const boss = await admin()
    const stats = (await call('GET', '/api/v1/admin/stats', boss.token)).json()
    expect(stats).toMatchObject({ accounts: 2, admins: 1, courses: 0 })
    expect((await call('GET', '/api/v1/me', boss.token)).json().account.role).toBe('admin')
  })

  it('disables an account - signing it out everywhere - and enables it again', async () => {
    const boss = await admin()
    const target = await signUp(server, 'troublemaker')
    const found = (await call('GET', '/api/v1/admin/accounts?q=trouble', boss.token)).json()
    expect(found.items.map((a: { username: string }) => a.username)).toEqual(['troublemaker'])
    expect((await call('POST', `/api/v1/admin/accounts/${target.id}/disable`, boss.token)).json().disabledAt).toBeTruthy()
    expect((await call('GET', '/api/v1/me', target.token)).statusCode).toBe(401)
    const login = await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'troublemaker', password: 'correct horse battery' } })
    expect(login.json().error.code).toBe('account_disabled')
    expect((await call('POST', `/api/v1/admin/accounts/${target.id}/enable`, boss.token)).json().disabledAt).toBeNull()
    // An administrator cannot lock themselves out, or leave the server without one.
    expect((await call('POST', `/api/v1/admin/accounts/${boss.id}/disable`, boss.token)).json().error.code).toBe('self')
    expect((await call('PUT', `/api/v1/admin/accounts/${boss.id}/role`, boss.token, { role: 'member' })).json().error.code).toBe('self')
  })

  it('grants and revokes the admin role, never leaving the server without one', async () => {
    const boss = await admin()
    const helper = await signUp(server, 'helper')
    expect((await call('PUT', `/api/v1/admin/accounts/${helper.id}/role`, boss.token, { role: 'admin' })).json().role).toBe('admin')
    expect((await call('GET', '/api/v1/admin/stats', helper.token)).statusCode).toBe(200)
    expect((await call('PUT', `/api/v1/admin/accounts/${boss.id}/role`, helper.token, { role: 'member' })).json().role).toBe('member')
    expect((await call('GET', '/api/v1/admin/stats', boss.token)).statusCode).toBe(403)
    expect(() => setRole(server.ctx.db, null, helper.id, 'member')).toThrow('only administrator')
  })

  it('moderates a course: hidden, mailed, not undone by a new version or by its owner', async () => {
    const boss = await admin()
    const author = await signUp(server, 'author')
    const { courseId, local } = localCourse()
    await publish(server, author.token, courseId, local, '0.1.0')
    expect((await call('POST', `/api/v1/admin/courses/${courseId}/moderate`, boss.token, { reason: '  ' })).json().error.code).toBe('reason_required')
    const moderated = (await call('POST', `/api/v1/admin/courses/${courseId}/moderate`, boss.token, { reason: 'Copied from a paid course.' })).json()
    expect(moderated).toMatchObject({ listed: false, moderation: { reason: 'Copied from a paid course.' } })
    expect(server.outbox.messages.at(-1)).toMatchObject({ subject: expect.stringContaining('was removed'), text: expect.stringContaining('Copied from a paid course.') })

    const anonymous = () => server.app.inject({ method: 'GET', url: `/api/v1/courses/${courseId}` })
    expect((await anonymous()).statusCode).toBe(404)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/courses' })).json().total).toBe(0)
    // The owner still sees it, with the reason, and cannot list it again.
    const managed = (await call('GET', `/api/v1/courses/${courseId}/versions`, author.token)).json()
    expect(managed.moderation).toMatchObject({ reason: 'Copied from a paid course.' })
    const relist = await call('POST', `/api/v1/courses/${courseId}/relist`, author.token)
    expect(relist.json().error).toMatchObject({ code: 'moderated', message: expect.stringContaining('Copied from a paid course.') })
    // Publishing clears the owner's unlisting, never a moderator's.
    expect((await publish(server, author.token, courseId, local, '0.2.0')).statusCode).toBe(200)
    expect((await anonymous()).statusCode).toBe(404)

    const states = async (state: string) => (await call('GET', `/api/v1/admin/courses?state=${state}`, boss.token)).json().items.map((c: { id: string }) => c.id)
    expect(await states('moderated')).toEqual([courseId])
    expect(await states('listed')).toEqual([])
    expect((await call('POST', `/api/v1/admin/courses/${courseId}/restore`, boss.token)).json()).toMatchObject({ listed: true, moderation: null })
    expect((await anonymous()).statusCode).toBe(200)
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/courses?q=llvm' })).json().total).toBe(1)
  })

  it('writes every change to the audit log, by name', async () => {
    const boss = await admin('chief')
    const target = await signUp(server, 'someone')
    await call('POST', `/api/v1/admin/accounts/${target.id}/disable`, boss.token)
    await call('POST', `/api/v1/admin/accounts/${target.id}/enable`, boss.token)
    const log = (await call('GET', '/api/v1/admin/audit', boss.token)).json()
    expect(log.items.map((e: { action: string; actor: string; targetName: string }) => `${e.actor} ${e.action} ${e.targetName}`))
      .toEqual(['chief account.enable someone', 'chief account.disable someone', 'command line account.grant-admin chief'])
    expect((await call('GET', '/api/v1/admin/audit?q=grant', boss.token)).json().total).toBe(1)
  })
})
