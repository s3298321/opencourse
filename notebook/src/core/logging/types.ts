/**
 * The shape of one log line, and of anything that can receive one.
 *
 * `LogSink` is the seam this whole module exists for: the database and the dev
 * console are two sinks, and sending logs anywhere else later - a file, a
 * remote collector - is one more class with a `write`, added with `addSink`.
 * Nothing that *writes* a log knows or cares where it goes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Stored as a number so "sort by level" sorts by severity rather than by the
 * alphabet, which would put debug above error.
 */
export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** The level a stored rank stands for; an unknown rank reads as the nearest one below it. */
export function levelOfRank(rank: number): LogLevel {
  let found: LogLevel = 'debug'
  for (const level of LOG_LEVELS) if (rank >= LEVEL_RANK[level]) found = level
  return found
}

export interface LogRecord {
  /** Epoch milliseconds. */
  at: number
  level: LogLevel
  /** Which part of the app said it: `openai`, `authoring`, `renderer`, … */
  scope: string
  message: string
  /**
   * Whoever was selected when it was written, or null for a line that belongs
   * to nobody - startup, a crash, anything before the picker.
   */
  userId: string | null
  /** Already JSON-safe and scrubbed by the time a sink sees it. */
  data?: Record<string, unknown>
}

export interface LogSink {
  readonly name: string
  /** The quietest level this sink wants; anything below is never built for it. */
  minLevel: LogLevel
  /** Must not throw - but the logger survives one that does. */
  write(record: LogRecord): void
  /** Push out anything buffered. Called before reads that must see the latest line, and on quit. */
  flush?(): void
  close?(): void
}
