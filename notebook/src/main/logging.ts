/**
 * Where log lines go, wired once at startup. This is the file to change to send
 * them somewhere else: write a `LogSink` (core/logging/types.ts) and add it
 * here. Nothing that writes a log needs to change.
 *
 * - **database**, always: `logs.db` under userData, `info` and above. It is
 *   what the Logs page reads, and what you have after the fact.
 * - **console**, under `npm run dev` (or `OPENCOURSE_LOG_CONSOLE=1`): every
 *   level, so a terminal shows what the app is doing as it does it. Any other
 *   unpackaged run - smoke, shots, preview - prints warnings and errors only,
 *   which is what it printed before there was a log. A packaged app prints
 *   nothing; `OPENCOURSE_LOG_CONSOLE=0` turns it off anywhere.
 *
 * `OPENCOURSE_LOG_LEVEL` lowers or raises both, for chasing one problem.
 */
import { app } from 'electron'
import { consoleSink } from '../core/logging/console'
import { isLogLevel, type LogLevel } from '../core/logging/types'
import { log } from './log'
import { databaseSink } from './logdb'
import { currentUserId } from './users'
import { closeLogDb } from './db'

function levelFromEnv(fallback: LogLevel): LogLevel {
  const raw = process.env['OPENCOURSE_LOG_LEVEL']?.toLowerCase()
  return isLogLevel(raw) ? raw : fallback
}

export function installLogSinks(): void {
  log.setContext(() => ({ userId: currentUserId() }))
  log.addSink(databaseSink({ minLevel: levelFromEnv('info') }))
  const choice = process.env['OPENCOURSE_LOG_CONSOLE']
  const dev = Boolean(process.env['ELECTRON_RENDERER_URL']) || choice === '1'
  const colours = Boolean(process.stdout.isTTY)
  if (choice === '0') return
  if (dev) log.addSink(consoleSink({ minLevel: levelFromEnv('debug'), colours }))
  else if (!app.isPackaged) log.addSink(consoleSink({ minLevel: levelFromEnv('warn'), colours }))
}

/** On will-quit, after every before-quit handler has had its say. */
export function closeLogSinks(): void {
  log.flush()
  log.close()
  closeLogDb()
}
