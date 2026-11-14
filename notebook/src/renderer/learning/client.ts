import { InterruptedConnection } from '@core/network-retry'
import type { LearningClient } from '../../learning-ui/client'
const clients = new Map<string, LearningClient>()
export function desktopLearningClient(server: string): LearningClient {
  let client = clients.get(server)
  if (!client) {
    client = { async request<T>(path: string, method: 'GET'|'POST'|'PUT'|'DELETE' = 'GET', body?: unknown) {
      const result = await window.opencourse.learningChatRequest<T>(server, path, method, body)
      if ('connectionError' in result) throw new InterruptedConnection(result.connectionError)
      return result.value
    } }
    clients.set(server, client)
  }
  return client
}
