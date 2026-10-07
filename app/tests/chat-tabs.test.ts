import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDraft, useChatPanel, type ChatPanel, type PanelSummary } from '../src/renderer/sidechat/useChat'
import type { ChatSendResult, ReasoningEffort } from '../src/core/types'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function fixture(scope: 'chat' | 'project') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const summary = (id: string): PanelSummary => ({ id, title: id === 'new' ? '' : 'Existing conversation', model: 'gpt-5.1', provider: 'apiKey', reasoning: null, courseId: 'demo', messages: 0, createdAt: 'now', updatedAt: 'now' })
  let chats = [summary('old'), summary('other')]
  const stored = new Map<string, number>()
  const create = vi.fn(async () => { const chat = summary('new'); chats = [chat, ...chats]; return chat })
  const remove = vi.fn(async (id: string) => { chats = chats.filter(chat => chat.id !== id) })
  const configure = (id: string, fields: Partial<PanelSummary>) => { chats = chats.map(chat => chat.id === id ? { ...chat, ...fields } : chat); return structuredClone(chats.find(chat => chat.id === id)!) }
  const setModel = vi.fn(async (id: string, model: string) => configure(id, { model }))
  const setReasoning = vi.fn(async (id: string, reasoning: ReasoningEffort | null) => configure(id, { reasoning }))
  const send = vi.fn(async (id: string): Promise<ChatSendResult> => { stored.set(id, (stored.get(id) ?? 0) + 1); return { status: 'ok' } as ChatSendResult })
  const prefix = scope === 'chat' ? 'Chat' : 'ProjectChat'
  const api: Record<string, unknown> = {
    listChatModels: async () => ({ models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }, { id: 'gpt-5.2', label: 'GPT-5.2', reasoningEfforts: ['low', 'high'] }],
      defaults: { model: 'gpt-5.1', reasoning: null }, webSearch: false, connection: { provider: 'apiKey', ready: true } }),
    onAIChanged: () => () => {}
  }
  api[`list${prefix}s`] = async () => structuredClone(chats)
  api[`get${prefix}`] = async (id: string) => ({ chat: structuredClone(chats.find(chat => chat.id === id)!), messages: Array.from({ length: stored.get(id) ?? 0 }, (_, seq) => ({ seq, role: 'user', text: 'hi' })) })
  api[`create${prefix}`] = create
  api[`delete${prefix}`] = remove
  api[`set${prefix}Model`] = setModel
  api[`set${prefix}Reasoning`] = setReasoning
  api[scope === 'chat' ? 'sendChatMessage' : 'sendProjectMessage'] = send
  for (const event of ['Delta', 'Done', 'Title', 'Error', 'Activity']) api[`on${prefix}${event}`] = () => () => {}
  vi.stubGlobal('opencourse', api)
  let panel!: ChatPanel
  function Fixture() {
    panel = useChatPanel('demo', { moduleId: 'module', lessonId: 'lesson' }, scope === 'project' ? 'project' : undefined)
    return createElement('span', null, panel.tabs.find(tab => tab.id === panel.activeId)?.model)
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Fixture)))
  await act(async () => panel.open('old'))
  return { panel: () => panel, create, remove, setModel, setReasoning, send, container, chats: () => chats }
}

describe.each(['chat', 'project'] as const)('%s tab lifecycle', scope => {
  it('replaces the last closed tab with a draft that exists nowhere but the tab', async () => {
    const f = await fixture(scope)
    await act(async () => f.panel().close('old'))
    const [tab] = f.panel().tabs
    expect(f.panel().tabs).toHaveLength(1)
    expect(isDraft(tab.id)).toBe(true)
    expect(f.panel().activeId).toBe(tab.id)
    expect(f.panel().thread).toEqual({ chat: tab, messages: [] })
    expect(tab.title).toBe('')
    expect(f.container.textContent).toBe('gpt-5.1')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.panel().chats.map(chat => chat.id)).toEqual(['old', 'other'])
    expect(f.remove).not.toHaveBeenCalled()
  })
  it('starts new tabs as drafts too, and closing one leaves no trace', async () => {
    const f = await fixture(scope)
    await act(async () => f.panel().startNew())
    const draft = f.panel().activeId!
    expect(isDraft(draft)).toBe(true)
    await act(async () => f.panel().close(draft))
    expect(f.panel().tabs.map(tab => tab.id)).toEqual(['old'])
    expect(f.panel().activeId).toBe('old')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('creates the chat on its first message, with the model and reasoning the draft was given', async () => {
    const f = await fixture(scope)
    await act(async () => f.panel().close('old'))
    await act(async () => f.panel().setModel('gpt-5.2'))
    await act(async () => f.panel().setReasoning('high'))
    expect(f.panel().tabs[0]).toMatchObject({ model: 'gpt-5.2', reasoning: 'high' })
    expect(f.create).not.toHaveBeenCalled(); expect(f.setModel).not.toHaveBeenCalled()
    await act(async () => { expect(await f.panel().send('hello')).toBe(true) })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.setModel).toHaveBeenCalledWith('new', 'gpt-5.2')
    expect(f.setReasoning).toHaveBeenCalledWith('new', 'high')
    expect(f.send.mock.calls[0][0]).toBe('new')
    expect(f.panel().tabs.map(tab => tab.id)).toEqual(['new'])
    expect(f.panel().activeId).toBe('new')
    expect(f.panel().chats.some(chat => chat.id === 'new')).toBe(true)
  })
  it('leaves nothing behind when the first message is refused, and keeps the draft to try again', async () => {
    const f = await fixture(scope)
    f.send.mockResolvedValueOnce({ status: 'no-key' } as ChatSendResult)
    await act(async () => f.panel().close('old'))
    const draft = f.panel().activeId
    await act(async () => { expect(await f.panel().send('hello')).toBe(false) })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.remove).toHaveBeenCalledWith('new')
    expect(f.chats().some(chat => chat.id === 'new')).toBe(false)
    expect(f.panel().tabs.map(tab => tab.id)).toEqual([draft])
    expect(f.panel().activeId).toBe(draft)
    expect(f.panel().error).toBe('Chat needs an OpenAI key.')
  })
  it('closes a background tab without creating anything and handles rapid closes of the remaining tabs', async () => {
    const f = await fixture(scope)
    await act(async () => f.panel().open('other'))
    await act(async () => f.panel().close('old'))
    expect(f.panel().activeId).toBe('other')
    await act(async () => f.panel().open('old'))
    await act(async () => { f.panel().close('other'); f.panel().close('old') })
    expect(f.panel().tabs).toHaveLength(1)
    expect(isDraft(f.panel().activeId)).toBe(true)
    expect(f.create).not.toHaveBeenCalled()
  })
  it('also leaves a draft when the last tab\'s chat is deleted', async () => {
    const f = await fixture(scope)
    await act(async () => { await f.panel().remove('old') })
    expect(f.remove).toHaveBeenCalledWith('old')
    expect(f.panel().chats.some(chat => chat.id === 'old')).toBe(false)
    expect(isDraft(f.panel().activeId)).toBe(true)
    expect(f.create).not.toHaveBeenCalled()
  })
})
