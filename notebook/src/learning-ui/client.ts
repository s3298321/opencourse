export interface LearningClient {
  request<T>(path: string, method?: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T>
  events?(chatId: string, onEvent: () => void): () => void
}
