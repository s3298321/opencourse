import { useEffect, useState } from 'react'
import { normalizeCitations } from '@core/sidechat/citations'
import type { ChatMessage, ChatQuote } from '@core/types'
import type { ReadingSource } from '@core/documents/types'
import type { ContentRef, LearningChat, LearningMessage, ServerAISettings } from '@core/learning/types'
import type { LearningClient } from '../../learning-ui/client'
import { useReadingTabs } from '../../learning-ui/useReadingTabs'
import type { ChatPanel as Panel, PanelSummary } from '../sidechat/useChat'
import ChatPanel from '../components/ChatPanel'
import { ScreenActivityProvider, useScreenActive } from '../screen-activity'

const noSourceIcons = async () => ({})
const serverManaged = async () => {}

/** Adapt the server wire format to the same transcript used for local chats. */
export function serverMessage(message: LearningMessage, seq: number, source: ContentRef, localId: string): ChatMessage {
  return {
    seq, role: message.role, text: message.text, at: message.at,
    status: message.status === 'error' ? 'failed' : message.status === 'cancelled' || message.status === 'interrupted' ? 'stopped' : 'complete',
    quote: message.quote ? { text: message.quote, from: source.kind === 'course' ? 'lesson' : 'document' } : undefined,
    citations: normalizeCitations(message.citations),
    localSources: message.citations.flatMap((c): ReadingSource[] => {
      if (c.url) return []
      if (source.kind === 'document' && c.page) return [{ kind: 'document', documentId: localId, page: c.page, title: c.title }]
      if (source.kind === 'course' && c.moduleId) return [{ kind: 'course', courseId: localId, moduleId: c.moduleId, lessonId: c.lessonId, title: c.title }]
      return []
    })
  }
}

export interface ServerReadingProps {
  quote: ChatQuote | null
  onQuoteUsed: () => void
  visible?: boolean
  onClose?: () => void
  onAddKey: () => void
  textScale?: number
  onSource?: (source: ReadingSource) => void
}

export function ServerReadingChat({ client, source, draftKey, localId, visible = true, ...props }: ServerReadingProps & {
  client: LearningClient
  source: ContentRef
  draftKey: string
  localId: string
}) {
  const screenActive = useScreenActive() && visible
  const reading = useReadingTabs(client, source, `opencourse:reading-draft:${draftKey}`)
  const [settings, setSettings] = useState<ServerAISettings | null>(null)
  const [connectionError, setConnectionError] = useState('')
  useEffect(() => {
    if (!screenActive) return
    let alive = true
    const refresh = async () => {
      try {
        const next = await client.request<ServerAISettings>('/me/ai')
        if (alive) { setSettings(next); setConnectionError('') }
      } catch (error) {
        if (alive) { setSettings(null); setConnectionError((error as Error).message) }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    window.addEventListener('focus', refresh)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [client, screenActive])
  const summary = (chat: LearningChat): PanelSummary => ({
    id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.lastMessageAt ?? chat.createdAt,
    messages: chat.messages ?? 0, lastMessageAt: chat.lastMessageAt, historyLabel: 'Conversation',
    model: settings?.model ?? '', reasoning: settings?.reasoning ?? null, provider: 'apiKey'
  })
  const chats = reading.chats.map(summary)
  const tabs = reading.tabs.map(id => chats.find(chat => chat.id === id) ?? summary({
    id, title: '', kind: source.kind, contentId: source.id, version: source.version, createdAt: ''
  }))
  const ready = !!settings?.configured && settings.enabled
  const running = reading.view?.messages.find(message => message.status === 'running')
  const busy = new Set(reading.chats.filter(chat => chat.running).map(chat => chat.id))
  if (reading.busy || reading.answering) busy.add(reading.active)
  const panel: Panel = {
    chats, tabs, activeId: reading.active,
    thread: { chat: tabs.find(chat => chat.id === reading.active)!, messages: (reading.view?.messages ?? [])
      .flatMap((message, seq) => message.status === 'running' ? [] : [serverMessage(message, seq, source, localId)]) },
    streaming: running?.text ?? (reading.busy ? '' : null), busy,
    error: reading.error || connectionError || null,
    models: [], webSearch: settings?.webSearch ?? false, ready,
    connectionLoading: !settings && !connectionError,
    provider: 'apiKey', defaultProvider: 'apiKey', connections: {},
    connection: { provider: 'apiKey', ready, message: connectionError || (settings?.enabled === false
      ? 'AI is disabled on this server.' : 'Configure an API key in this server’s settings to enable chat.') },
    settingsManagedBy: 'Server', loading: reading.loading,
    activity: running?.activity?.label ?? null, toolRunning: running?.activity?.running ?? false, sendBlocked: !ready || reading.loading || reading.sending,
    setActive: reading.open, open: reading.open, close: reading.close,
    startNew: async () => { reading.startNew() }, resume: async () => {}, remove: reading.remove, refreshHistory: reading.refreshHistory,
    send: (text, quote) => ready ? reading.send(quote?.text, text) : Promise.resolve(false),
    stop: () => { void client.request(`/learning/chats/${reading.active}/cancel`, 'POST', {})
      .catch(error => reading.setError(error.message)) },
    setModel: serverManaged, setReasoning: serverManaged, setProvider: serverManaged
  }
  return <ScreenActivityProvider value={screenActive}><ChatPanel
    {...props} visible={visible} variant={source.kind === 'course' ? 'lesson' : 'document'} panel={panel}
    composer={{ text: reading.text, setText: reading.setText }} sourceIcons={noSourceIcons}
  /></ScreenActivityProvider>
}
