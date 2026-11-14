import { NETWORK_RETRIES } from './chat-network'

export class InterruptedConnection extends Error {}

const networkCode = /^(?:net::)?(?:ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED|FAILED|TIMED_OUT)|TIMED_OUT|QUIC_PROTOCOL_ERROR|HTTP2_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH)|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))\b/

export function isNetworkInterruption(error: unknown): boolean {
  if (error instanceof InterruptedConnection) return true
  if (!(error instanceof Error) || error.name === 'OpenAIError' || error.name === 'AbortError') return false
  if (error instanceof AggregateError) return error.errors.some(isNetworkInterruption)
  const code = (error as Error & {code?: string}).code
  if (code && networkCode.test(code) || networkCode.test(error.message)) return true
  if (error.cause && error.cause !== error) return isNetworkInterruption(error.cause)
  return error instanceof TypeError && /^(?:failed to fetch|fetch failed|network error|network request failed|load failed|networkerror when attempting to fetch resource\.|terminated)$/i.test(error.message)
}

export class NetworkRetriesExhausted extends Error {}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Replays one request. Callers retain its inputs or idempotency key across attempts. */
export async function withNetworkRetries<T>(
  request: (retry: boolean, connected: () => void) => Promise<T>,
  signal: AbortSignal,
  notify: (attempt: number | null) => void,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = retryDelay,
  exhaustedMessage = `The AI connection is still unavailable after ${NETWORK_RETRIES} retries. Send a message to continue when the connection is stable.`
): Promise<T> {
  let warning = false
  const connected = () => {
    if (warning) { warning = false; notify(null) }
  }
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      try {
        return await request(attempt > 0, connected)
      } catch (error) {
        signal.throwIfAborted()
        if (!isNetworkInterruption(error)) throw error
        if (attempt === NETWORK_RETRIES) {
          throw new NetworkRetriesExhausted(exhaustedMessage, { cause: error })
        }
        warning = true
        notify(attempt + 1)
        await wait(1000 * 2 ** attempt, signal)
      }
    }
  } finally { connected() }
}
