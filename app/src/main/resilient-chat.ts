import type { WebContents } from 'electron'
import type { ResearchSnapshot } from '../core/authoring/research'
import type { ChatRecoveryEvent } from '../core/chat-network'
import { streamChat, type ChatStreamOptions } from './openai'
import { withNetworkRetries } from './network-retry'

export function chatRetryNotice(sender: WebContents, id: string) {
  return (attempt: number | null) => {
    if (!sender.isDestroyed()) sender.send('chat:recovery', id, {kind: 'retry', attempt} satisfies ChatRecoveryEvent)
  }
}

/** The failed attempt's partial answer stays visible during backoff. When its
 * replacement produces output, swap just this round's text and evidence. */
export function streamChatRound(sender: WebContents, id: string, restoreRound: () => string, options: ChatStreamOptions & { signal: AbortSignal }) {
  return withNetworkRetries(async (retry, connected) => {
    let replaced = false
    let pendingResearch: ResearchSnapshot | undefined
    function replace() {
      if (retry && !replaced && !options.signal.aborted) {
        replaced = true
        const text = restoreRound()
        if (!sender.isDestroyed()) sender.send('chat:recovery', id, {kind: 'replace', text} satisfies ChatRecoveryEvent)
        if (pendingResearch) options.onResearch?.(pendingResearch)
      }
    }
    const result = await streamChat({
      ...options, onConnected: connected,
      onDelta: text => { replace(); options.onDelta(text) },
      onResearch: options.onResearch && (snapshot => {
        if (retry && !replaced) pendingResearch = snapshot
        else options.onResearch?.(snapshot)
      })
    })
    if (!result.aborted) replace()
    return result
  }, options.signal, chatRetryNotice(sender, id))
}
