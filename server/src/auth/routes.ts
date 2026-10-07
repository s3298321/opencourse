/**
 * Accounts. The app walks the person through sign-up itself, and so does the
 * web app; both use these routes.
 *
 *   register/start {email}            -> 202, a code is mailed
 *   register/verify {email, code}     -> {ticket}   (the address is confirmed)
 *   username?name=                    -> {available, reason}
 *   register/complete {ticket, username, password} -> {token, account}
 *
 * A sign-in (complete, login, password/reset) answers `{token, account}` to
 * the app. The web app adds `session: "cookie"` and gets `{account}` instead,
 * with the token in an HttpOnly cookie it can never read (auth/cookie.ts).
 *
 * Nothing here says whether an address has an account: start and forgot both
 * answer 202 either way, and an address that already has an account is mailed
 * a note saying so instead of a code. Login fails with one message for a wrong
 * name and a wrong password alike.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { emailProblem, isCode, passwordProblem, usernameProblem, type Account, type AccountDetails, type AccountRole, type AuthResult, type WebAuthResult } from '@core/catalog/api'
import { nowIso, tx, type Db } from '../db'
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../errors'
import { RateLimiter } from '../ratelimit'
import type { Ctx } from '../context'
import { burnPasswordTime, hashPassword, verifyPassword } from './passwords'
import { checkCode, issueCode } from './codes'
import { createSession, revokeAccountSessions, revokeSession } from './sessions'
import { clearSessionCookie, sessionCookie, setSessionCookie } from './cookie'
import { sha256 } from './secrets'
import { audit } from '../audit'

const TICKET_TTL_MS = 15 * 60_000

const emailBody = { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 } } } as const
const codeBody = { type: 'object', required: ['email', 'code'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, code: { type: 'string', maxLength: 12 } } } as const
/** The web app's sign-ins ask for a cookie instead of a token. */
const sessionProperty = { session: { type: 'string', enum: ['cookie'] } } as const

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null
}

export function requireAccount(request: FastifyRequest): Account {
  if (!request.account) throw unauthorized()
  return request.account
}

export function requireAdmin(request: FastifyRequest): Account {
  const account = requireAccount(request)
  if (request.role !== 'admin') throw forbidden('not_admin', 'Only an administrator can do that.')
  return account
}

export function cleanEmail(raw: string): string {
  const email = raw.trim()
  const problem = emailProblem(email)
  if (problem) throw badRequest('invalid_email', problem)
  return email
}

export function accountDetails(d: Db, id: string): AccountDetails | null {
  const row = d.prepare('SELECT id, username, email, role, created_at FROM accounts WHERE id = ?').get(id) as
    { id: string; username: string; email: string; role: AccountRole; created_at: string } | undefined
  return row ? { id: row.id, username: row.username, email: row.email, role: row.role, createdAt: row.created_at } : null
}

/** Where a code can be typed: the app, and this server's own web pages. */
export const enterItIn = (publicUrl: string): string => `Enter it in OpenCourse or on ${publicUrl}`

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db: d, secret, mailer, config } = ctx
  const perEmail = new RateLimiter(3, 10 * 60_000)
  const perIp = new RateLimiter(30, 60 * 60_000)
  const logins = new RateLimiter(10, 15 * 60_000)
  const verifies = new RateLimiter(20, 15 * 60_000)
  const limit = (limiter: RateLimiter, key: string): void => { if (!limiter.hit(key)) throw tooMany() }

  const accountByLogin = (login: string) => d.prepare('SELECT id, username, email, password_hash, disabled_at FROM accounts WHERE email = ? OR username = ?')
    .get(login, login) as { id: string; username: string; email: string; password_hash: string; disabled_at: string | null } | undefined

  /** Signs the account in: a token for the app, a cookie for the web app. */
  const signIn = (request: FastifyRequest, reply: FastifyReply, account: Account): AuthResult | WebAuthResult => {
    const userAgent = String(request.headers['user-agent'] ?? '')
    if ((request.body as { session?: string }).session === 'cookie') {
      setSessionCookie(reply, config, createSession(d, account.id, { kind: 'web', userAgent }))
      return { account: accountDetails(d, account.id)! }
    }
    return { token: createSession(d, account.id, { kind: 'app', userAgent }), account: { id: account.id, username: account.username, email: account.email } }
  }

  app.post('/api/v1/auth/register/start', { schema: { body: emailBody } }, async (request, reply) => {
    if (config.registration !== 'open') throw forbidden('registration_closed', 'This server is not accepting new accounts.')
    const email = cleanEmail((request.body as { email: string }).email)
    limit(perIp, `register:${request.ip}`); limit(perEmail, `register:${email.toLowerCase()}`)
    const existing = d.prepare('SELECT username FROM accounts WHERE email = ?').get(email) as { username: string } | undefined
    if (existing) {
      await mailer.send({ to: email, subject: `You already have an account on ${config.name}`, text: `Someone - probably you - tried to create an account on ${config.name} (${config.publicUrl}) with this address.\n\nThis address already has an account: ${existing.username}. Sign in instead, or use "Forgot password?" if you no longer know the password.\n\nIf this was not you, you can ignore this message.` })
    } else {
      const code = issueCode(d, secret, 'register', email)
      await mailer.send({ to: email, subject: `Your ${config.name} code: ${code}`, text: `Your code to confirm this address on ${config.name} is:\n\n    ${code}\n\n${enterItIn(config.publicUrl)}. It expires in 10 minutes. If you did not ask for it, ignore this message.` })
    }
    return reply.code(202).send({ ok: true })
  })

  app.post('/api/v1/auth/register/verify', { schema: { body: codeBody } }, async (request) => {
    const { email: raw, code } = request.body as { email: string; code: string }
    const email = cleanEmail(raw)
    limit(verifies, `verify:${request.ip}`)
    if (!isCode(code.trim())) throw badRequest('invalid_code', 'Enter the 6-digit code from the email.')
    const checked = checkCode(d, secret, 'register', email, code.trim())
    if (!checked.ok) throw badRequest('invalid_code', checked.attemptsLeft ? 'That code is not right.' : 'That code has expired or was tried too often. Ask for a new one.', { attemptsLeft: checked.attemptsLeft })
    const ticket = randomBytes(32).toString('base64url')
    d.prepare('DELETE FROM registration_tickets WHERE email = ? OR expires_at <= ?').run(email, nowIso())
    d.prepare('INSERT INTO registration_tickets(ticket_hash, email, expires_at) VALUES (?, ?, ?)').run(sha256(ticket), email, new Date(Date.now() + TICKET_TTL_MS).toISOString())
    return { ticket }
  })

  app.get('/api/v1/auth/username', { schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 64 } } } } }, async (request) => {
    const name = (request.query as { name: string }).name
    const problem = usernameProblem(name)
    if (problem) return { available: false, reason: problem }
    const taken = d.prepare('SELECT 1 FROM accounts WHERE username = ?').get(name)
    return taken ? { available: false, reason: 'That name is taken.' } : { available: true }
  })

  app.post('/api/v1/auth/register/complete', {
    schema: { body: { type: 'object', required: ['ticket', 'username', 'password'], additionalProperties: false, properties: { ticket: { type: 'string', maxLength: 100 }, username: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 1024 }, ...sessionProperty } } }
  }, async (request, reply) => {
    const { ticket, username, password } = request.body as { ticket: string; username: string; password: string }
    const row = d.prepare('SELECT email, expires_at FROM registration_tickets WHERE ticket_hash = ?').get(sha256(ticket)) as { email: string; expires_at: string } | undefined
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw badRequest('invalid_ticket', 'This sign-up has expired. Start again with your email address.')
    const nameProblem = usernameProblem(username)
    if (nameProblem) throw badRequest('invalid_username', nameProblem)
    const pwProblem = passwordProblem(password)
    if (pwProblem) throw badRequest('weak_password', pwProblem)
    const hash = await hashPassword(password)
    const account = { id: randomUUID(), username, email: row.email }
    tx(d, () => {
      if (d.prepare('SELECT 1 FROM accounts WHERE email = ?').get(row.email)) throw conflict('email_registered', 'This address already has an account. Sign in instead.')
      if (d.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username)) throw conflict('username_taken', 'That name is taken.')
      d.prepare('INSERT INTO accounts(id, email, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(account.id, account.email, account.username, hash, nowIso())
      d.prepare('DELETE FROM registration_tickets WHERE ticket_hash = ?').run(sha256(ticket))
    })
    request.log.info({ accountId: account.id }, 'account created')
    return reply.code(201).send(signIn(request, reply, account))
  })

  app.post('/api/v1/auth/login', {
    schema: { body: { type: 'object', required: ['login', 'password'], additionalProperties: false, properties: { login: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 1024 }, ...sessionProperty } } }
  }, async (request, reply) => {
    const { login: raw, password } = request.body as { login: string; password: string }
    const login = raw.trim()
    limit(logins, `login:${request.ip}`); limit(logins, `login:${login.toLowerCase()}`)
    const account = accountByLogin(login)
    if (!account) { await burnPasswordTime(password); throw unauthorized('That name or password is not right.') }
    if (!(await verifyPassword(password, account.password_hash))) throw unauthorized('That name or password is not right.')
    if (account.disabled_at) throw forbidden('account_disabled', 'This account has been disabled.')
    logins.reset(`login:${login.toLowerCase()}`)
    return signIn(request, reply, account)
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = bearer(request) ?? sessionCookie(request, config)
    if (token) revokeSession(d, token)
    clearSessionCookie(reply, config)
    return reply.code(204).send()
  })

  app.get('/api/v1/auth/me', async (request) => ({ account: requireAccount(request) }))

  app.post('/api/v1/auth/password/forgot', { schema: { body: emailBody } }, async (request, reply) => {
    const email = cleanEmail((request.body as { email: string }).email)
    limit(perIp, `forgot:${request.ip}`); limit(perEmail, `forgot:${email.toLowerCase()}`)
    const account = d.prepare('SELECT username, disabled_at FROM accounts WHERE email = ?').get(email) as { username: string; disabled_at: string | null } | undefined
    if (account && !account.disabled_at) {
      const code = issueCode(d, secret, 'reset', email)
      await mailer.send({ to: email, subject: `Your ${config.name} password reset code: ${code}`, text: `Your code to reset the password of ${account.username} on ${config.name} is:\n\n    ${code}\n\n${enterItIn(config.publicUrl)}. It expires in 10 minutes. If you did not ask for it, ignore this message - your password has not changed.` })
    }
    return reply.code(202).send({ ok: true })
  })

  app.post('/api/v1/auth/password/reset', {
    schema: { body: { type: 'object', required: ['email', 'code', 'password'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, code: { type: 'string', maxLength: 12 }, password: { type: 'string', maxLength: 1024 }, ...sessionProperty } } }
  }, async (request, reply) => {
    const { email: raw, code, password } = request.body as { email: string; code: string; password: string }
    const email = cleanEmail(raw)
    limit(verifies, `reset:${request.ip}`)
    const pwProblem = passwordProblem(password)
    if (pwProblem) throw badRequest('weak_password', pwProblem)
    if (!isCode(code.trim())) throw badRequest('invalid_code', 'Enter the 6-digit code from the email.')
    const checked = checkCode(d, secret, 'reset', email, code.trim())
    if (!checked.ok) throw badRequest('invalid_code', checked.attemptsLeft ? 'That code is not right.' : 'That code has expired or was tried too often. Ask for a new one.', { attemptsLeft: checked.attemptsLeft })
    const account = d.prepare('SELECT id, username, email FROM accounts WHERE email = ? AND disabled_at IS NULL').get(email) as { id: string; username: string; email: string } | undefined
    if (!account) throw badRequest('invalid_code', 'That code has expired or was tried too often. Ask for a new one.', { attemptsLeft: 0 })
    const hash = await hashPassword(password)
    tx(d, () => {
      d.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, account.id)
      revokeAccountSessions(d, account.id)
      audit(d, { actor: account, action: 'password.reset', targetKind: 'account', targetId: account.id, targetName: account.username })
    })
    return signIn(request, reply, account)
  })
}
