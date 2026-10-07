/**
 * The logger, with no database and no Electron: what a sink receives, whose
 * line it is, and that nothing secret or unbounded gets through.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_DATA_CHARS, MAX_MESSAGE_CHARS, createLogger } from '../src/core/logging/logger'
import { consoleSink, formatForConsole } from '../src/core/logging/console'
import { levelOfRank, type LogLevel, type LogRecord, type LogSink } from '../src/core/logging/types'
import { scrubSecrets } from '../src/core/coach/key'

function memory(minLevel: LogLevel = 'debug', name = 'memory'): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = []
  return { name, minLevel, records, write: (record) => records.push(record) }
}

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'

describe('levels', () => {
  it('gives each sink only the levels it asked for', () => {
    const log = createLogger()
    const everything = memory('debug', 'everything')
    const loud = memory('warn', 'loud')
    log.addSink(everything)
    log.addSink(loud)
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(everything.records.map((r) => r.level)).toEqual(['debug', 'info', 'warn', 'error'])
    expect(loud.records.map((r) => r.message)).toEqual(['w', 'e'])
  })

  it('reads a stored rank back as a level', () => {
    expect(levelOfRank(10)).toBe('debug')
    expect(levelOfRank(30)).toBe('warn')
    expect(levelOfRank(45)).toBe('error')
    expect(levelOfRank(0)).toBe('debug')
  })

  it('builds nothing for a level no sink wants', () => {
    const scrub = vi.fn((text: string) => text)
    const log = createLogger({ scrub })
    log.addSink(memory('error'))
    log.debug('quiet', { big: 'x'.repeat(10_000) })
    expect(scrub).not.toHaveBeenCalled()
  })
})

describe('whose line it is', () => {
  it('reads the user when the line is written, so a switch takes effect at once', () => {
    let user: string | null = null
    const log = createLogger({ context: () => ({ userId: user }) })
    const sink = memory()
    log.addSink(sink)
    log.info('before anyone')
    user = 'u_ada'
    log.info('as Ada')
    user = 'u_bob'
    log.child('chat').info('as Bob')
    expect(sink.records.map((r) => r.userId)).toEqual([null, 'u_ada', 'u_bob'])
  })

  it('lets a flow that captured its owner pin it, null included', () => {
    const log = createLogger({ context: () => ({ userId: 'u_now' }) })
    const sink = memory()
    log.addSink(sink)
    log.child('chat', { userId: 'u_owner' }).info('pinned')
    log.child('users', { userId: null }).info('general')
    expect(sink.records.map((r) => r.userId)).toEqual(['u_owner', null])
  })

  it('names scopes, merges bound data, and nests children', () => {
    const log = createLogger()
    const sink = memory()
    log.addSink(sink)
    log.info('root')
    const chat = log.child('chat', { data: { chatId: 'c1' } })
    chat.info('answered', { ms: 12 })
    chat.child('title').warn('naming failed')
    expect(sink.records.map((r) => r.scope)).toEqual(['app', 'chat', 'chat.title'])
    expect(sink.records[1]!.data).toEqual({ chatId: 'c1', ms: 12 })
    expect(sink.records[2]!.data).toEqual({ chatId: 'c1' })
  })
})

describe('what a record may hold', () => {
  it('keeps the parts of an Error a reader needs', () => {
    const log = createLogger()
    const sink = memory()
    log.addSink(sink)
    const error = Object.assign(new Error('refused'), { status: 429 })
    log.error('failed', error)
    log.error('failed again', { error })
    const first = sink.records[0]!.data!['error'] as Record<string, unknown>
    expect(first).toMatchObject({ name: 'Error', message: 'refused', status: 429 })
    expect(String(first['stack'])).toContain('refused')
    expect(sink.records[1]!.data!['error']).toMatchObject({ message: 'refused' })
  })

  it('survives cycles, bigints, functions and odd numbers', () => {
    const log = createLogger()
    const sink = memory()
    log.addSink(sink)
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    expect(() => log.info('odd', { cyclic, big: 10n, fn: () => 1, nan: NaN, when: new Date(0) })).not.toThrow()
    expect(sink.records[0]!.data).toEqual({ cyclic: { name: 'loop', self: '[circular]' }, big: '10', nan: 'NaN', when: '1970-01-01T00:00:00.000Z' })
  })

  it('wraps a value that is not an object', () => {
    const log = createLogger()
    const sink = memory()
    log.addSink(sink)
    log.info('a number', 42)
    expect(sink.records[0]!.data).toEqual({ value: 42 })
  })

  it('caps the message and the data', () => {
    const log = createLogger()
    const sink = memory()
    log.addSink(sink)
    log.info('m'.repeat(MAX_MESSAGE_CHARS * 2), { list: Array.from({ length: 40 }, (_, i) => 'x'.repeat(400) + i) })
    const record = sink.records[0]!
    expect(record.message.length).toBeLessThan(MAX_MESSAGE_CHARS + 50)
    expect(JSON.stringify(record.data).length).toBeLessThan(MAX_DATA_CHARS + 100)
    expect(record.data!['truncated']).toBeTypeOf('string')
  })
})

describe('secrets', () => {
  it('reach no sink, in the message or anywhere inside the data', () => {
    const log = createLogger({ scrub: scrubSecrets })
    const sink = memory()
    log.addSink(sink)
    log.error(`OpenAI rejected ${KEY}`, { headers: { Authorization: `Bearer ${KEY}` }, list: [KEY], error: new Error(`bad key ${KEY}`) })
    const json = JSON.stringify(sink.records)
    expect(json).not.toContain('sk-proj')
    expect(json).toContain('[redacted]')
  })

  it('scrubs strings one by one, so a pattern cannot eat into the JSON around it', () => {
    const log = createLogger({ scrub: scrubSecrets })
    const sink = memory()
    log.addSink(sink)
    log.info('redirect', { url: 'https://example.com/cb?code=abc123', next: 'kept' })
    expect(sink.records[0]!.data).toEqual({ url: 'https://example.com/cb?code=[redacted]', next: 'kept' })
  })
})

describe('a sink that fails', () => {
  it('neither throws to the caller nor stops the other sinks, and is reported once', () => {
    const fallback = vi.fn()
    const log = createLogger({ fallback })
    const broken: LogSink = { name: 'broken', minLevel: 'debug', write: () => { throw new Error('disk full') } }
    const sink = memory()
    log.addSink(broken)
    log.addSink(sink)
    expect(() => {
      log.info('one')
      log.info('two')
    }).not.toThrow()
    expect(sink.records.map((r) => r.message)).toEqual(['one', 'two'])
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0]![0]).toContain('disk full')
  })

  it('a context that throws costs the user, not the line', () => {
    const log = createLogger({ context: () => { throw new Error('no session') } })
    const sink = memory()
    log.addSink(sink)
    log.info('still written')
    expect(sink.records[0]).toMatchObject({ message: 'still written', userId: null })
  })

  it('can be replaced and removed by name', () => {
    const log = createLogger()
    const first = memory('debug', 'db')
    const second = memory('debug', 'db')
    log.addSink(first)
    log.addSink(second)
    log.info('to the second')
    log.removeSink('db')
    log.info('to nobody')
    expect(first.records).toHaveLength(0)
    expect(second.records.map((r) => r.message)).toEqual(['to the second'])
    expect(log.sinks()).toHaveLength(0)
  })

  it('flushes and closes every sink, even past one that throws', () => {
    const fallback = vi.fn()
    const log = createLogger({ fallback })
    const flushed: string[] = []
    log.addSink({ name: 'a', minLevel: 'info', write: () => {}, flush: () => { throw new Error('nope') } })
    log.addSink({ name: 'b', minLevel: 'info', write: () => {}, flush: () => flushed.push('b'), close: () => flushed.push('b closed') })
    log.flush()
    log.close()
    expect(flushed).toEqual(['b', 'b closed'])
    expect(fallback).toHaveBeenCalled()
  })
})

describe('the console sink', () => {
  it('writes one readable line per record, to the stream its level belongs on', () => {
    const at = new Date(2026, 9, 7, 9, 5, 3, 7).getTime()
    const record: LogRecord = { at, level: 'warn', scope: 'openai', message: 'refused', userId: 'u_1', data: { status: 429 } }
    expect(formatForConsole(record)).toBe('09:05:03.007 WARN  openai refused {"status":429} user=u_1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})
    const sink = consoleSink({ minLevel: 'debug' })
    sink.write(record)
    sink.write({ ...record, level: 'error' })
    sink.write({ ...record, level: 'info' })
    expect([warn.mock.calls.length, error.mock.calls.length, info.mock.calls.length]).toEqual([1, 1, 1])
    warn.mockRestore()
    error.mockRestore()
    info.mockRestore()
  })
})
