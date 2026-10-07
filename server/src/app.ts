/**
 * The server as a value: buildApp() returns a Fastify instance that has not
 * started listening, so tests drive it with inject() or an ephemeral port and
 * src/index.ts is all that a real start adds.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { ServerConfig } from './config'
import type { Ctx } from './context'
import { openDb } from './db'
import { ApiError } from './errors'
import { Outbox, smtpMailer, type Mailer } from './auth/mailer'
import { serverSecret } from './auth/secrets'
import { sessionAccount } from './auth/sessions'
import { bearer, registerAuthRoutes } from './auth/routes'
import { registerCatalogRoutes } from './catalog/routes'
import { registerPublishRoutes } from './publish/routes'
import { registerWebRoutes } from './web/routes'
import { notFoundHtml } from './web/templates'
import { PAGE_CSP } from './web/routes'

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
  app.decorateRequest('account', null)
  app.addHook('onRequest', async (request) => {
    const token = bearer(request)
    request.account = token ? sessionAccount(db, token) : null
  })

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...error.extra } })
    if ('validation' in error && error.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: error.message } })
    const status = 'statusCode' in error ? error.statusCode : undefined
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: status === 413 ? 'too_large' : 'invalid_request', message: error.message } })
    request.log.error(error)
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } })
  })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } })
    return reply.code(404).type('text/html; charset=utf-8').header('Content-Security-Policy', PAGE_CSP)
      .send(notFoundHtml({ name: config.name, description: config.description, publicUrl: config.publicUrl, registration: config.registration }))
  })

  registerAuthRoutes(app, ctx)
  registerCatalogRoutes(app, ctx)
  registerPublishRoutes(app, ctx)
  registerWebRoutes(app, ctx)

  // A development server has no SMTP; this is where its codes go. Never
  // registered otherwise, so a public server cannot be asked for anyone's code.
  if (config.dev && ctx.outbox) {
    const outbox = ctx.outbox
    app.get('/dev/outbox', async () => ({ messages: outbox.messages }))
  }
  app.addHook('onClose', async () => { db.close() })
  return { app, ctx }
}
