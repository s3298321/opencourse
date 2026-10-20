import type { LearningClient } from '../../learning-ui/client'
const clients = new Map<string, LearningClient>()
export function desktopLearningClient(server: string): LearningClient {
  let client = clients.get(server)
  if (!client) {
    client = { request: (path, method = 'GET', body) => window.opencourse.learningRequest(server, path, method, body) }
    clients.set(server, client)
  }
  return client
}
