/**
 * Whether a server is there, from what the app's own requests found out.
 *
 * Every request main makes reports its outcome: any HTTP answer - a 401 and a
 * 500 included - means the server is there; a refused connection or a
 * timeout means it is not. A server that is not there is looked at again on a
 * backoff, so the app notices when it comes back without anyone pressing
 * anything, and without asking a dead host every second.
 *
 * Pure, so the rule is a unit test rather than something read out of a log
 * (tests/server-health.test.ts); main/server-health.ts owns the timer.
 */
export type ServerStatus = 'unknown' | 'online' | 'unreachable'

export interface ServerHealth {
  status: ServerStatus
  /** When the status last changed. */
  since: number
  /** Failed requests and probes in a row. */
  failures: number
  /** When to look again; null while the server answers. */
  nextProbeAt: number | null
}

export type HealthEvent =
  | { kind: 'answered'; at: number }
  | { kind: 'failed'; at: number }
  /** Someone pressed Retry, or the Mac woke: look now, and start the backoff over. */
  | { kind: 'wake'; at: number }

export const PROBE_MIN_MS = 5_000
export const PROBE_MAX_MS = 60_000

/** 5s, 10s, 20s, 40s, then every minute. */
export function probeDelay(failures: number): number {
  return Math.min(PROBE_MAX_MS, PROBE_MIN_MS * 2 ** Math.max(0, failures - 1))
}

export const UNKNOWN_HEALTH: ServerHealth = { status: 'unknown', since: 0, failures: 0, nextProbeAt: null }

export function nextHealth(previous: ServerHealth | undefined, event: HealthEvent): ServerHealth {
  const prev = previous ?? UNKNOWN_HEALTH
  switch (event.kind) {
    case 'answered':
      return { status: 'online', since: prev.status === 'online' ? prev.since : event.at, failures: 0, nextProbeAt: null }
    case 'failed': {
      const failures = prev.failures + 1
      return { status: 'unreachable', since: prev.status === 'unreachable' ? prev.since : event.at, failures, nextProbeAt: event.at + probeDelay(failures) }
    }
    case 'wake':
      return prev.status === 'unreachable' ? { ...prev, failures: 0, nextProbeAt: event.at } : prev
  }
}
