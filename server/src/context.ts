import type { Account } from '@core/catalog/api'
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
    /** The signed-in account, from a Bearer token; null for anonymous requests. */
    account: Account | null
  }
}
