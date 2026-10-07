/**
 * Everything the server is told from outside, read once from the environment.
 * A missing variable has a default that is safe on a developer's machine; a
 * public deployment sets OPENCOURSE_SERVER_PUBLIC_URL and SMTP, and runs behind
 * a TLS proxy (README.md) - the app refuses plain HTTP to anything but loopback.
 */
import { resolve } from 'node:path'

export interface ServerConfig {
  port: number
  host: string
  dataDir: string
  name: string
  description: string
  /** Where people reach the server, for links in emails and on the web pages. */
  publicUrl: string
  smtpUrl: string | null
  mailFrom: string
  registration: 'open' | 'closed'
  /** No SMTP: codes go to stdout and to GET /dev/outbox. Never on a public server. */
  dev: boolean
  /** Honour X-Forwarded-For for rate limits; set when behind a proxy. */
  trustProxy: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['OPENCOURSE_SERVER_PORT'] ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OPENCOURSE_SERVER_PORT must be a port number')
  const host = env['OPENCOURSE_SERVER_HOST'] ?? '127.0.0.1'
  const registration = env['OPENCOURSE_REGISTRATION'] ?? 'open'
  if (registration !== 'open' && registration !== 'closed') throw new Error('OPENCOURSE_REGISTRATION must be open or closed')
  return {
    port,
    host,
    dataDir: resolve(env['OPENCOURSE_SERVER_DATA'] ?? 'data'),
    name: env['OPENCOURSE_SERVER_NAME'] ?? 'OpenCourse server',
    description: env['OPENCOURSE_SERVER_DESCRIPTION'] ?? 'Courses shared by the people who use this server.',
    publicUrl: (env['OPENCOURSE_SERVER_PUBLIC_URL'] ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`).replace(/\/+$/, ''),
    smtpUrl: env['OPENCOURSE_SMTP_URL'] || null,
    mailFrom: env['OPENCOURSE_MAIL_FROM'] ?? 'OpenCourse <no-reply@localhost>',
    registration,
    dev: env['OPENCOURSE_SERVER_DEV'] === '1',
    trustProxy: env['OPENCOURSE_TRUST_PROXY'] === '1'
  }
}
