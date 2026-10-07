/**
 * The server as a value: buildApp() returns a Fastify instance that has not
 * started listening, so tests drive it with inject() or an ephemeral port and
 * src/index.ts is all that a real start adds.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import type { ServerConfig } from './config'
import type { Ctx } from './context'
import { openDb } from './db'
import { ApiError, forbidden } from './errors'
import { Outbox, smtpMailer, type Mailer } from './auth/mailer'
import { serverSecret } from './auth/secrets'
import { sessionAccount } from './auth/sessions'
import { bearer, registerAuthRoutes } from './auth/routes'
import { sameOrigin, sessionCookie } from './auth/cookie'
import { registerAccountRoutes } from './account/routes'
import { registerAdminRoutes } from './admin/routes'
import { registerCatalogRoutes } from './catalog/routes'
import { registerPublishRoutes } from './publish/routes'
import { createShell, registerWebRoutes } from './web/routes'

export interface BuildOptions {
  config: ServerConfig
  /** Tests pass an Outbox to read codes from. */
  mailer?: Mailer
  logger?: boolean
}

export async function buildApp(options: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config } = options
  mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(join(config.dataDir, 'server.db'))
  let mailer = options.mailer
  if (!mailer) {
    if (config.smtpUrl) mailer = await smtpMailer(config.smtpUrl, config.mailFrom)
    else if (config.dev) mailer = new Outbox()
    else throw new Error('No way to send sign-up codes: set OPENCOURSE_SMTP_URL, or OPENCOURSE_SERVER_DEV=1 on a development machine.')
  }
  const ctx: Ctx = { config, db, secret: serverSecret(config.dataDir), mailer, outbox: mailer instanceof Outbox ? mailer : null }

  const app = Fastify({ logger: options.logger ?? true, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 })
  await app.register(fastifyCookie)
  app.decorateRequest('account', null)
  app.decorateRequest('role', null)
  app.decorateRequest('sessionId', null)
  app.decorateRequest('via', null)
  // The app's Bearer token first; the web app's cookie only when there is none,
  // and only for a request this origin made (auth/cookie.ts).
  app.addHook('onRequest', async (request) => {
    const token = bearer(request)
    const cookie = token ? null : sessionCookie(request, config)
    if (cookie && !sameOrigin(request, config)) throw forbidden('cross_site', 'This request did not come from this site.')
    const presented = token ?? cookie
    const viewer = presented ? sessionAccount(db, presented) : null
    if (!viewer) return
    request.account = viewer.account
    request.role = viewer.role
    request.sessionId = viewer.sessionId
    request.via = token ? 'app' : 'web'
  })

  // A page is answered with the web app's shell, an API call with JSON - errors included.
  const shell = createShell(ctx)
  const wantsPage = (request: FastifyRequest): boolean => (request.method === 'GET' || request.method === 'HEAD')
    && !request.url.startsWith('/api/') && !request.url.startsWith('/dev/') && String(request.headers.accept ?? '').includes('text/html')
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...error.extra } })
    if ('validation' in error && error.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: error.message } })
    const status = 'statusCode' in error ? error.statusCode : undefined
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: status === 413 ? 'too_large' : 'invalid_request', message: error.message } })
    request.log.error(error)
    if (wantsPage(request)) {
      try { return shell.send(request, reply, 500) } catch { /* the shell itself failed: answer plainly */ }
    }
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } })
  })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || !wantsPage(request)) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } })
    return shell.send(request, reply, 404)
  })

  registerAuthRoutes(app, ctx)
  registerAccountRoutes(app, ctx)
  registerAdminRoutes(app, ctx)
  registerCatalogRoutes(app, ctx)
  registerPublishRoutes(app, ctx)
  registerWebRoutes(app, ctx, shell)

  // A development server has no SMTP; this is where its codes go. Never
  // registered otherwise, so a public server cannot be asked for anyone's code.
  if (config.dev && ctx.outbox) {
    const outbox = ctx.outbox
    app.get('/dev/outbox', async () => ({ messages: outbox.messages }))
  }
  app.addHook('onClose', async () => { db.close() })
  return { app, ctx }
}
