/**
 * Everything the server is told from outside, read once from the environment.
 * A missing variable has a default that is safe on a developer's machine; a
 * public deployment sets OPENCOURSE_SERVER_PUBLIC_URL and SMTP, and runs behind
 * a TLS proxy (README.md) - the app refuses plain HTTP to anything but loopback.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_APP_URL } from '../shared/pages'

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
  /** Where "Get the app" points. */
  appUrl: string
  /** The operator's privacy policy and legal notice, linked from every page; null for no link. */
  privacyUrl: string | null
  legalUrl: string | null
  /** The built web app (dist/web); null when there is none, as in a fresh checkout's `npm run dev`. */
  webDir: string | null
}

/** dist/web beside the bundle, or the build in dist/ when running from src/ with tsx. */
function defaultWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, 'web'), join(here, '..', 'dist', 'web')].find((dir) => existsSync(join(dir, 'index.html'))) ?? null
}

/** An optional link the operator sets: http(s) or nothing, so a typo fails at start rather than in a footer. */
function linkUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]
  if (!value) return null
  if (!/^https?:\/\/[^\s"'<>]+$/.test(value)) throw new Error(`${name} must be an http(s) URL`)
  return value
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
    trustProxy: env['OPENCOURSE_TRUST_PROXY'] === '1',
    appUrl: env['OPENCOURSE_SERVER_APP_URL'] || DEFAULT_APP_URL,
    privacyUrl: linkUrl(env, 'OPENCOURSE_SERVER_PRIVACY_URL'),
    legalUrl: linkUrl(env, 'OPENCOURSE_SERVER_LEGAL_URL'),
    webDir: env['OPENCOURSE_SERVER_WEB_DIR'] ? resolve(env['OPENCOURSE_SERVER_WEB_DIR']) : defaultWebDir()
  }
}
