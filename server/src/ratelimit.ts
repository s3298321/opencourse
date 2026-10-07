/**
 * Fixed windows per key, in memory. The server is one process, so memory is the
 * whole truth; a restart forgets, which costs an attacker nothing they did not
 * already have. Keys are pruned as their windows close, so the map stays the
 * size of the last window's traffic.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private lastPrune = 0

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one attempt; false when the key is over its limit for this window. */
  hit(key: string): boolean {
    const now = this.now()
    if (now - this.lastPrune > this.windowMs) this.prune(now)
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    entry.count++
    return entry.count <= this.limit
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  private prune(now: number): void {
    this.lastPrune = now
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key)
  }
}
