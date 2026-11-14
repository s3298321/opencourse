/**
 * The terminal sink, for `npm run dev`. One line per record, readable at a
 * glance: time, level, scope, message, then whatever data came with it.
 */
import type { LogLevel, LogRecord, LogSink } from './types'

const COLOURS: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function formatForConsole(record: LogRecord, colours = false): string {
  const level = record.level.toUpperCase().padEnd(5)
  const data = record.data ? ` ${JSON.stringify(record.data)}` : ''
  const user = record.userId ? ` user=${record.userId}` : ''
  if (!colours) return `${clock(record.at)} ${level} ${record.scope} ${record.message}${data}${user}`
  return `${DIM}${clock(record.at)}${RESET} ${COLOURS[record.level]}${level}${RESET} ${record.scope} ${record.message}${DIM}${data}${user}${RESET}`
}

export function consoleSink(options: { minLevel: LogLevel; colours?: boolean }): LogSink {
  return {
    name: 'console',
    minLevel: options.minLevel,
    write: (record) => {
      const line = formatForConsole(record, options.colours ?? false)
      if (record.level === 'error') console.error(line)
      else if (record.level === 'warn') console.warn(line)
      else console.log(line)
    }
  }
}
