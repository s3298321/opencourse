import { useMemo, useRef } from 'react'
import { useConversationPanel, type ChatTransport } from '../sidechat/useChat'

export function useDocumentChat(documentId: string, page: number, visible: boolean, storageKey: string) {
  const position = useRef(page)
  position.current = page
  const transport = useMemo<ChatTransport>(() => {
    const api = window.opencourse
    return { list: () => api.listDocumentChats(documentId), get: api.getDocumentChat, create: () => api.createDocumentChat(documentId, position.current),
      remove: api.deleteDocumentChat, send: (id, text, quote) => api.sendDocumentMessage(id, text, quote, position.current), cancel: api.cancelDocumentChat,
      setModel: api.setDocumentChatModel, setReasoning: api.setDocumentChatReasoning, setProvider: api.setDocumentChatProvider,
      onDelta: api.onDocumentChatDelta, onDone: api.onDocumentChatDone, onError: api.onDocumentChatError, onTitle: api.onDocumentChatTitle, onActivity: api.onDocumentChatActivity }
  }, [documentId])
  return useConversationPanel(transport, 'chat', visible, storageKey)
}
