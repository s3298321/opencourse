import { describe, expect, it } from 'vitest'
import { nextHealth, probeDelay, PROBE_MAX_MS, PROBE_MIN_MS, type ServerHealth } from '@core/catalog/health'

describe('server health', () => {
  it('any answer means the server is there', () => {
    const health = nextHealth(undefined, { kind: 'answered', at: 100 })
    expect(health).toEqual({ status: 'online', since: 100, failures: 0, nextProbeAt: null })
    expect(nextHealth(health, { kind: 'answered', at: 200 }).since).toBe(100)
  })

  it('a failure makes it unreachable and schedules a look on a growing backoff', () => {
    let health: ServerHealth | undefined
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      health = nextHealth(health, { kind: 'failed', at: 1000 })
      delays.push(health.nextProbeAt! - 1000)
    }
    expect(health!.status).toBe('unreachable')
    expect(health!.since).toBe(1000)
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
    expect(probeDelay(1)).toBe(PROBE_MIN_MS)
    expect(probeDelay(50)).toBe(PROBE_MAX_MS)
  })

  it('coming back resets everything', () => {
    let health = nextHealth(undefined, { kind: 'failed', at: 1 })
    health = nextHealth(health, { kind: 'failed', at: 2 })
    health = nextHealth(health, { kind: 'answered', at: 3 })
    expect(health).toEqual({ status: 'online', since: 3, failures: 0, nextProbeAt: null })
  })

  it('a wake looks now and starts the backoff over, but only for a server that is down', () => {
    let health = nextHealth(undefined, { kind: 'failed', at: 1 })
    health = nextHealth(health, { kind: 'failed', at: 2 })
    const woken = nextHealth(health, { kind: 'wake', at: 50 })
    expect(woken).toMatchObject({ status: 'unreachable', failures: 0, nextProbeAt: 50 })
    expect(nextHealth(woken, { kind: 'failed', at: 60 }).nextProbeAt).toBe(60 + PROBE_MIN_MS)
    const online = nextHealth(undefined, { kind: 'answered', at: 1 })
    expect(nextHealth(online, { kind: 'wake', at: 5 })).toBe(online)
  })
})
