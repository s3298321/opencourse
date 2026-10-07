/**
 * The logger: builds a record once, scrubs it, and hands it to every sink that
 * wants its level.
 *
 * Three rules, each the reason something here looks the way it does:
 *
 * - **A log never takes the app down.** Nothing in here throws to its caller -
 *   not a cyclic object, not a sink that fails. A broken sink is reported once
 *   through `fallback` and the others still get the line.
 * - **A secret never reaches a sink.** `scrub` (main injects `scrubSecrets`)
 *   runs over the message and every string inside the data *before* any sink
 *   sees them, so the console, the database and whatever is added later all
 *   receive the same clean record. Strings are scrubbed one by one rather than
 *   as serialized JSON, because some of the patterns would happily eat a
 *   closing quote.
 * - **The user is read when the line is written.** `context()` is asked every
 *   time, which is how "once a user is selected, every log after carries them"
 *   happens without anyone passing an id around. A flow that captured its owner
 *   up front can pin it with `child(scope, { userId })`.
 */
import { LEVEL_RANK, type LogLevel, type LogRecord, type LogSink } from './types'

/** Long enough for any sentence; short enough that a pasted payload cannot become the message. */
export const MAX_MESSAGE_CHARS = 2000
/** Per string inside `data`. */
export const MAX_STRING_CHARS = 4000
/** The serialized `data` of one record. */
export const MAX_DATA_CHARS = 8000
const MAX_DEPTH = 6
const MAX_ITEMS = 50
const MAX_STACK_LINES = 12

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  /**
   * A logger for one part of the app. `bound.data` is merged into every line it
   * writes; `bound.userId` pins the user instead of reading the session.
   */
  child(scope: string, bound?: { userId?: string | null; data?: LogFields }): Logger
}

export interface LogHub extends Logger {
  addSink(sink: LogSink): void
  removeSink(name: string): void
  sinks(): readonly LogSink[]
  /** Replaces where the current user comes from. */
  setContext(context: () => { userId: string | null }): void
  flush(): void
  close(): void
}

export interface LoggerOptions {
  scrub?: (text: string) => string
  context?: () => { userId: string | null }
  /** Where a failing sink is reported. Never a sink itself, or a broken one would loop. */
  fallback?: (text: string) => void
  now?: () => number
  /** The scope of lines written on the hub itself. */
  scope?: string
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more]` : text
}

/**
 * Anything into something JSON can hold, with every string scrubbed. Errors
 * keep what a reader needs - name, message, an HTTP status or code if they have
 * one, the top of the stack - and lose nothing else that matters.
 */
function safe(value: unknown, scrub: (text: string) => string, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null
  switch (typeof value) {
    case 'string':
      return cap(scrub(value), MAX_STRING_CHARS)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'function':
    case 'symbol':
      return undefined
  }
  const object = value as object
  if (seen.has(object)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[…]'
  seen.add(object)
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    if (value instanceof Error) {
      const error = value as Error & { status?: unknown; code?: unknown; cause?: unknown }
      const out: LogFields = { name: error.name, message: safe(error.message, scrub, depth + 1, seen) }
      if (typeof error.status === 'number') out['status'] = error.status
      if (typeof error.code === 'string' || typeof error.code === 'number') out['code'] = error.code
      if (error.stack) out['stack'] = safe(error.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'), scrub, depth + 1, seen)
      if (error.cause !== undefined) out['cause'] = safe(error.cause, scrub, depth + 1, seen)
      return out
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => safe(item, scrub, depth + 1, seen) ?? null)
      if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`)
      return items
    }
    const out: LogFields = {}
    let count = 0
    for (const [key, item] of Object.entries(value as LogFields)) {
      if (++count > MAX_ITEMS) {
        out['…'] = 'more keys omitted'
        break
      }
      const clean = safe(item, scrub, depth + 1, seen)
      if (clean !== undefined) out[key] = clean
    }
    return out
  } finally {
    seen.delete(object)
  }
}

/** A record's `data`: always an object, always under the size cap. */
function toData(bound: LogFields | undefined, data: unknown, scrub: (text: string) => string): LogFields | undefined {
  if (data === undefined && !bound) return undefined
  const own = data === undefined
    ? {}
    : data instanceof Error
      ? { error: data }
      : data && typeof data === 'object' && !Array.isArray(data)
        ? (data as LogFields)
        : { value: data }
  const clean = safe({ ...bound, ...own }, scrub, 0, new WeakSet()) as LogFields
  if (!Object.keys(clean).length) return undefined
  const json = JSON.stringify(clean)
  return json.length > MAX_DATA_CHARS ? { truncated: cap(json, MAX_DATA_CHARS) } : clean
}

export function createLogger(options: LoggerOptions = {}): LogHub {
  const scrub = options.scrub ?? ((text: string) => text)
  const fallback = options.fallback ?? ((text: string) => console.error(text))
  const now = options.now ?? Date.now
  let context = options.context ?? (() => ({ userId: null }))
  let sinks: LogSink[] = []
  const reported = new Set<string>()

  const userNow = (): string | null => {
    try {
      return context().userId ?? null
    } catch {
      return null
    }
  }

  const emit = (level: LogLevel, scope: string, message: string, data: unknown, bound?: { userId?: string | null; data?: LogFields }): void => {
    try {
      const rank = LEVEL_RANK[level]
      const targets = sinks.filter((sink) => rank >= LEVEL_RANK[sink.minLevel])
      // A debug line in a build that keeps none costs a filter, not a serialization.
      if (!targets.length) return
      const record: LogRecord = {
        at: now(),
        level,
        scope,
        message: cap(scrub(typeof message === 'string' ? message : String(message)), MAX_MESSAGE_CHARS),
        userId: bound && 'userId' in bound ? (bound.userId ?? null) : userNow()
      }
      const fields = toData(bound?.data, data, scrub)
      if (fields) record.data = fields
      for (const sink of targets) {
        try {
          sink.write(record)
        } catch (err) {
          if (!reported.has(sink.name)) {
            reported.add(sink.name)
            fallback(`[log] the ${sink.name} sink failed and is being skipped for this line: ${scrub((err as Error)?.message ?? String(err))}`)
          }
        }
      }
    } catch {
      /* a log must never be the thing that fails */
    }
  }

  const make = (scope: string, bound?: { userId?: string | null; data?: LogFields }): Logger => ({
    debug: (message, data) => emit('debug', scope, message, data, bound),
    info: (message, data) => emit('info', scope, message, data, bound),
    warn: (message, data) => emit('warn', scope, message, data, bound),
    error: (message, data) => emit('error', scope, message, data, bound),
    child: (sub, more) => {
      const merged: { userId?: string | null; data?: LogFields } = { ...bound, ...more }
      if (bound?.data || more?.data) merged.data = { ...bound?.data, ...more?.data }
      return make(scope === (options.scope ?? 'app') ? sub : `${scope}.${sub}`, merged)
    }
  })

  const root = make(options.scope ?? 'app')
  const each = (fn: (sink: LogSink) => void): void => {
    for (const sink of sinks) {
      try {
        fn(sink)
      } catch (err) {
        fallback(`[log] the ${sink.name} sink failed: ${scrub((err as Error)?.message ?? String(err))}`)
      }
    }
  }

  return {
    ...root,
    addSink: (sink) => {
      sinks = [...sinks.filter((s) => s.name !== sink.name), sink]
      reported.delete(sink.name)
    },
    removeSink: (name) => {
      sinks = sinks.filter((s) => s.name !== name)
    },
    sinks: () => sinks,
    setContext: (next) => {
      context = next
    },
    flush: () => each((sink) => sink.flush?.()),
    close: () => each((sink) => sink.close?.())
  }
}
