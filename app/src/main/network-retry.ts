import { setTimeout as delay } from 'node:timers/promises'
import { withNetworkRetries as retry } from '../core/network-retry'
export { InterruptedConnection, isNetworkInterruption } from '../core/network-retry'

export function withNetworkRetries<T>(request: (retrying: boolean, connected: () => void) => Promise<T>, signal: AbortSignal, notify: (attempt: number | null) => void) {
  return retry(request, signal, notify, (ms, abort) => delay(ms, undefined, { signal: abort }))
}
