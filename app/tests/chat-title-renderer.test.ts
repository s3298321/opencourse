import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatPanel, type ChatPanel, type PanelSummary } from '../src/renderer/sidechat/useChat'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('conversation title notifications', () => {
  it.each(['chat', 'project'] as const)('updates %s tabs and history while a follow-up is streaming, without interrupting it', async scope => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let summary: PanelSummary = { id: 'conversation', title: '', model: 'gpt-5.1', provider: 'apiKey', reasoning: null, courseId: 'demo', messages: 0, createdAt: 'now', updatedAt: 'now' }
    const subscribers = new Map<string, (...args: any[]) => void>()
    const offTitle = vi.fn()
    const subscribe = (name: string) => (handler: (...args: any[]) => void) => {
      subscribers.set(name, handler)
      return name.endsWith('Title') ? offTitle : () => {}
    }
    const prefix = scope === 'chat' ? 'Chat' : 'ProjectChat'
    const api: Record<string, unknown> = {
      listChatModels: async () => ({ models: [], webSearch: false, connection: { provider: 'apiKey', ready: true } }),
      onAIChanged: () => () => {}
    }
    api[`list${prefix}s`] = async () => [structuredClone(summary)]
    api[`get${prefix}`] = async () => ({ chat: structuredClone(summary), messages: [] })
    api[`send${scope === 'chat' ? 'ChatMessage' : 'ProjectMessage'}`] = async () => ({ status: 'ok', seq: 0 })
    for (const event of ['Delta', 'Done', 'Title', 'Error', 'Activity']) api[`on${prefix}${event}`] = subscribe(`on${prefix}${event}`)
    vi.stubGlobal('opencourse', api)
    let panel!: ChatPanel
    const lesson = { moduleId: 'module', lessonId: 'lesson' }
    function Fixture() {
      panel = useChatPanel('demo', lesson, scope === 'project' ? 'project' : undefined)
      return createElement('span', null, panel.tabs[0]?.title || 'New chat')
    }
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(Fixture)))
    await act(async () => panel.open(summary.id))
    expect(container.textContent).toBe('New chat')
    summary = { ...summary, title: 'Explain callbacks', messages: 1 }
    await act(async () => { await panel.send('Explain callbacks') })
    expect(container.textContent).toBe('Explain callbacks')
    expect(panel.busy.has(summary.id)).toBe(true)
    await act(async () => subscribers.get(`on${prefix}Delta`)!(summary.id, 'Continuing answer'))
    summary = { ...summary, title: 'Understanding Callback Scheduling' }
    await act(async () => subscribers.get(`on${prefix}Title`)!(summary.id, summary.title))
    expect(container.textContent).toBe(summary.title)
    expect(panel.chats[0].title).toBe(summary.title)
    expect(panel.thread?.chat.title).toBe(summary.title)
    expect(panel.busy.has(summary.id)).toBe(true)
    expect(panel.error).toBeNull()
    await act(async () => root!.unmount())
    root = undefined
    expect(offTitle).toHaveBeenCalledOnce()
  })
})
