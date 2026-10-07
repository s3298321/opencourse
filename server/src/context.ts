import type { Account, AccountRole, SessionKind } from '@core/catalog/api'
import type { ServerConfig } from './config'
import type { Db } from './db'
import type { Mailer, Outbox } from './auth/mailer'

/** What every route can reach. Built once by buildApp, injected by tests. */
export interface Ctx {
  config: ServerConfig
  db: Db
  secret: Buffer
  mailer: Mailer
  /** The development outbox, when there is one. */
  outbox: Outbox | null
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account, from a Bearer token or the web app's cookie; null for anonymous requests. */
    account: Account | null
    role: AccountRole | null
    /** The public id of the session the request was made with. */
    sessionId: string | null
    /** How the request was signed in: the app's Bearer token or the web app's cookie. */
    via: SessionKind | null
  }
}
