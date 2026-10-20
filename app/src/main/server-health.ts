/**
 * Which connected servers are there right now (core/catalog/health.ts has the
 * rule). Every request reports its outcome through serverclient.ts; a server
 * that stops answering is probed on a backoff until it answers again, and
 * each change of status is announced, so the screens that need a server can
 * say so and stop offering what would fail - the way they would if the
 * public catalog went down.
 *
 * Only servers the current user is connected to are probed (`setHealthScope`):
 * a removed connection is forgotten rather than asked after forever.
 */
import { EventEmitter } from 'node:events'
import { nextHealth, type HealthEvent, type ServerHealth, type ServerStatus } from '../core/catalog/health'
import { log } from './log'
import { callServer, serverOutcomes } from './serverclient'

const logger = log.child('servers')
const PROBE_TIMEOUT_MS = 10_000

/** 'changed' (url, status) whenever a server's status changes. */
export const healthEvents = new EventEmitter()
const health = new Map<string, ServerHealth>()
const probing = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let scope: () => string[] = () => []

export function serverStatus(url: string): ServerStatus {
  return health.get(url)?.status ?? 'unknown'
}

/** Which servers may be probed: the current user's connections. */
export function setHealthScope(next: () => string[]): void {
  scope = next
  schedule()
}

function record(url: string, event: HealthEvent): void {
  const before = health.get(url)
  const after = nextHealth(before, event)
  health.set(url, after)
  if ((before?.status ?? 'unknown') !== after.status) {
    logger.info('Server status', { data: { host: hostOf(url), status: after.status } })
    healthEvents.emit('changed', url, after.status)
  }
  schedule()
}

serverOutcomes.on('answered', (url: string) => record(url, { kind: 'answered', at: Date.now() }))
serverOutcomes.on('failed', (url: string) => record(url, { kind: 'failed', at: Date.now() }))

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return 'invalid' }
}

function watched(): Set<string> {
  try { return new Set(scope()) } catch { return new Set() }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  const urls = watched()
  const due = [...health].filter(([url, h]) => h.nextProbeAt !== null && urls.has(url) && !probing.has(url)).map(([, h]) => h.nextProbeAt!)
  if (!due.length) return
  timer = setTimeout(() => void probeDue(), Math.max(0, Math.min(...due) - Date.now()))
  timer.unref?.()
}

async function probeDue(): Promise<void> {
  timer = undefined
  const now = Date.now(), urls = watched()
  const due = [...health].filter(([url, h]) => urls.has(url) && h.nextProbeAt !== null && h.nextProbeAt <= now).map(([url]) => url)
  await Promise.all(due.map(probe))
  schedule()
}

/** One look at /server. Its outcome reaches `record` through serverOutcomes like any request's. */
async function probe(url: string): Promise<void> {
  if (probing.has(url)) return
  probing.add(url)
  try {
    await callServer(url, '/server', (raw) => raw ?? {}, { route: '/server', timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined)
  } finally {
    probing.delete(url)
  }
}

/** Retry: look now and start the backoff over. Resolves once the look is done. */
export async function retryServer(url: string): Promise<ServerStatus> {
  record(url, { kind: 'wake', at: Date.now() })
  await probe(url)
  return serverStatus(url)
}

/** After sleep the network has changed under every server: look at the ones that were down. */
export function wakeServers(): void {
  for (const [url, h] of health) if (h.status === 'unreachable') health.set(url, nextHealth(h, { kind: 'wake', at: Date.now() }))
  schedule()
}

/** A connection nothing has asked yet: find out, without making anyone wait. */
export function discover(urls: string[]): void {
  for (const url of urls) if (serverStatus(url) === 'unknown') void probe(url)
}

/** The selected user changed: their servers are the ones to watch now. */
export function refreshHealth(): void {
  const urls = [...watched()]
  discover(urls)
  schedule()
}

/** Tests start from nothing. */
export function resetServerHealth(): void {
  health.clear()
  probing.clear()
  if (timer) clearTimeout(timer)
  timer = undefined
}
