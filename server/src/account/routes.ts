/**
 * Your account, signed in: what the web app's settings page is made of.
 *
 *   GET    /me                        the account, with its role
 *   POST   /me/password               {current, password}; signs out every other session
 *   POST   /me/email/start            {email, password}; mails a code to the new address
 *   POST   /me/email/verify           {email, code}; moves the account to it
 *   GET    /me/sessions               where this account is signed in
 *   DELETE /me/sessions/:id           signs one of them out
 *   POST   /me/sessions/revoke-others everywhere but here
 *   DELETE /me                        {password}; the account and its courses, for good
 *
 * Every change to a credential asks for the current password again, and the
 * old address hears about a new one - the two things that make a stolen
 * session worth less than a stolen password.
 */
import type { FastifyInstance } from 'fastify'
import { isCode, passwordProblem, type AccountRole, type SessionInfo, type SessionKind } from '@core/catalog/api'
import { tx } from '../db'
import { badRequest, conflict, notFound, tooMany, unauthorized } from '../errors'
import { RateLimiter } from '../ratelimit'
import type { Ctx } from '../context'
import { audit } from '../audit'
import { accountDetails, cleanEmail, enterItIn, requireAccount } from '../auth/routes'
import { hashPassword, verifyPassword } from '../auth/passwords'
import { checkCode, issueCode } from '../auth/codes'
import { clearSessionCookie } from '../auth/cookie'
import { revokeAccountSessions } from '../auth/sessions'
import { removeCourseFiles } from '../publish/publish'

const password = { type: 'string', maxLength: 1024 } as const

export function registerAccountRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db: d, secret, mailer, config } = ctx
  const attempts = new RateLimiter(10, 15 * 60_000)
  const mails = new RateLimiter(5, 60 * 60_000)

  /** Checks the current password, counting failures against the account. */
  const confirmPassword = async (accountId: string, given: string): Promise<void> => {
    if (!attempts.hit(`me:${accountId}`)) throw tooMany()
    const row = d.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(accountId) as { password_hash: string } | undefined
    if (!row || !(await verifyPassword(given, row.password_hash))) throw unauthorized('That password is not right.')
    attempts.reset(`me:${accountId}`)
  }

  app.get('/api/v1/me', async (request) => {
    const details = accountDetails(d, requireAccount(request).id)
    if (!details) throw unauthorized()
    return { account: details }
  })

  app.post('/api/v1/me/password', {
    schema: { body: { type: 'object', required: ['current', 'password'], additionalProperties: false, properties: { current: password, password } } }
  }, async (request) => {
    const account = requireAccount(request)
    const body = request.body as { current: string; password: string }
    const problem = passwordProblem(body.password)
    if (problem) throw badRequest('weak_password', problem)
    await confirmPassword(account.id, body.current)
    const hash = await hashPassword(body.password)
    tx(d, () => {
      d.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, account.id)
      revokeAccountSessions(d, account.id, request.sessionId ?? undefined)
      audit(d, { actor: account, action: 'password.change', targetKind: 'account', targetId: account.id, targetName: account.username })
    })
    await mailer.send({ to: account.email, subject: `Your ${config.name} password was changed`, text: `The password of ${account.username} on ${config.name} (${config.publicUrl}) was just changed, and every other place this account was signed in has been signed out.\n\nIf this was not you, reset your password with "Forgot password?" right away.` })
    return { ok: true }
  })

  app.post('/api/v1/me/email/start', {
    schema: { body: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, password } } }
  }, async (request, reply) => {
    const account = requireAccount(request)
    const body = request.body as { email: string; password: string }
    const email = cleanEmail(body.email)
    if (email.toLowerCase() === account.email.toLowerCase()) throw badRequest('same_email', 'That is already this account\'s address.')
    await confirmPassword(account.id, body.password)
    if (!mails.hit(`email:${account.id}`)) throw tooMany()
    // As at sign-up, the answer is the same whether or not the address is taken;
    // its owner is told instead.
    if (d.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) {
      await mailer.send({ to: email, subject: `An account on ${config.name} tried to use this address`, text: `Someone signed in to ${config.name} (${config.publicUrl}) asked to move their account to this address. This address already has an account, so nothing was changed.\n\nIf this was you, sign in to that account instead.` })
    } else {
      const code = issueCode(d, secret, 'email', email, undefined, account.id)
      await mailer.send({ to: email, subject: `Your ${config.name} code: ${code}`, text: `Your code to make this the address of ${account.username} on ${config.name} is:\n\n    ${code}\n\n${enterItIn(config.publicUrl)}. It expires in 10 minutes. If you did not ask for it, ignore this message.` })
    }
    return reply.code(202).send({ ok: true })
  })

  app.post('/api/v1/me/email/verify', {
    schema: { body: { type: 'object', required: ['email', 'code'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, code: { type: 'string', maxLength: 12 } } } }
  }, async (request) => {
    const account = requireAccount(request)
    const body = request.body as { email: string; code: string }
    const email = cleanEmail(body.email)
    if (!attempts.hit(`me:${account.id}`)) throw tooMany()
    if (!isCode(body.code.trim())) throw badRequest('invalid_code', 'Enter the 6-digit code from the email.')
    const checked = checkCode(d, secret, 'email', email, body.code.trim(), undefined, account.id)
    if (!checked.ok) throw badRequest('invalid_code', checked.attemptsLeft ? 'That code is not right.' : 'That code has expired or was tried too often. Ask for a new one.', { attemptsLeft: checked.attemptsLeft })
    tx(d, () => {
      if (d.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) throw conflict('email_registered', 'That address already has an account.')
      d.prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, account.id)
      audit(d, { actor: account, action: 'email.change', targetKind: 'account', targetId: account.id, targetName: account.username })
    })
    await mailer.send({ to: account.email, subject: `Your ${config.name} address was changed`, text: `The address of ${account.username} on ${config.name} (${config.publicUrl}) is no longer this one.\n\nIf this was not you, contact the people who run ${config.name}.` })
    return { account: accountDetails(d, account.id)! }
  })

  app.get('/api/v1/me/sessions', async (request) => {
    const account = requireAccount(request)
    const rows = d.prepare('SELECT id, kind, user_agent, created_at, last_used_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_used_at DESC')
      .all(account.id, new Date().toISOString()) as { id: string; kind: SessionKind; user_agent: string; created_at: string; last_used_at: string }[]
    const sessions: SessionInfo[] = rows.map((r) => ({ id: r.id, kind: r.kind, userAgent: r.user_agent, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === request.sessionId }))
    return { sessions }
  })

  app.delete('/api/v1/me/sessions/:id', async (request, reply) => {
    const account = requireAccount(request)
    const id = (request.params as { id: string }).id
    const removed = d.prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?').run(id, account.id)
    if (!removed.changes) throw notFound('That session has already ended.')
    if (id === request.sessionId && request.via === 'web') clearSessionCookie(reply, config)
    return reply.code(204).send()
  })

  app.post('/api/v1/me/sessions/revoke-others', async (request) => {
    const account = requireAccount(request)
    revokeAccountSessions(d, account.id, request.sessionId ?? undefined)
    audit(d, { actor: account, action: 'sessions.revoke-others', targetKind: 'account', targetId: account.id, targetName: account.username })
    return { ok: true }
  })

  app.delete('/api/v1/me', {
    schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password } } }
  }, async (request, reply) => {
    const account = requireAccount(request)
    await confirmPassword(account.id, (request.body as { password: string }).password)
    const courses = deleteAccount(ctx, account.id, request.role)
    audit(d, { actor: account, action: 'account.delete', targetKind: 'account', targetId: account.id, targetName: account.username, detail: `by its owner; ${courses} course${courses === 1 ? '' : 's'} removed` })
    clearSessionCookie(reply, config)
    return reply.code(204).send()
  })
}

/**
 * Deletes an account and every course it published - rows, archives and covers.
 * Learners keep their own copies; they simply stop being offered updates.
 * Returns how many courses went with it.
 */
export function deleteAccount(ctx: Ctx, accountId: string, role: AccountRole | null): number {
  const d = ctx.db
  if (role === 'admin') {
    const admins = Number((d.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled_at IS NULL").get() as { n: number }).n)
    if (admins <= 1) throw conflict('last_admin', 'You are the only administrator. Make someone else an administrator first.')
  }
  const ids = (d.prepare('SELECT id FROM courses WHERE owner_id = ?').all(accountId) as { id: string }[]).map((r) => r.id)
  tx(d, () => {
    for (const id of ids) {
      d.prepare('DELETE FROM course_search WHERE course_id = ?').run(id)
      d.prepare('DELETE FROM courses WHERE id = ?').run(id)
    }
    d.prepare('DELETE FROM accounts WHERE id = ?').run(accountId)
  })
  for (const id of ids) removeCourseFiles(ctx.config.dataDir, id)
  return ids.length
}
