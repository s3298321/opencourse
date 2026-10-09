import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationPanel, type ChatPanel, type ChatTransport, type PanelThread } from '../src/renderer/sidechat/useChat'
import type { AIScope, ChatSendResult } from '../src/core/types'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(scope: AIScope) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('opencourse', {
    listChatModels: async () => ({ models: [], defaults: { model: 'model', reasoning: null }, connection: { provider: 'apiKey', ready: true } }),
    onAIChanged: () => () => {}
  })
  const stored = new Map<string, PanelThread>()
  const events: Record<string, (...args: any[]) => void> = {}
  const subscribe = (name: string) => (handler: (...args: any[]) => void) => { events[name] = handler; return () => {} }
  const create = vi.fn(async () => {
    const chat = { id: 'saved', courseId: 'course', title: '', messages: 0, model: 'model', reasoning: null, provider: 'apiKey' as const, createdAt: 'now', updatedAt: 'now' }
    stored.set(chat.id, { chat, messages: [] })
    return structuredClone(chat)
  })
  const commit = (id: string, text: string): ChatSendResult => {
    const thread = stored.get(id)!
    const seq = (thread.messages.at(-1)?.seq ?? -1) + 2 // Main can insert a context row before the user.
    thread.messages.push({ seq, role: 'user', text, at: 'now' })
    thread.chat = { ...thread.chat, title: thread.chat.title || text.slice(0, 120), messages: thread.messages.length }
    return { status: 'ok', seq }
  }
  const send = vi.fn(async (id: string, text: string) => commit(id, text))
  const transport: ChatTransport = {
    list: async () => structuredClone([...stored.values()].map(thread => thread.chat)),
    get: async id => structuredClone(stored.get(id) ?? null), create,
    remove: async id => { stored.delete(id) }, send, cancel: async () => {},
    setModel: async id => stored.get(id)!.chat, setReasoning: async id => stored.get(id)!.chat, setProvider: async id => stored.get(id)!.chat,
    onDelta: subscribe('delta'), onDone: subscribe('done'), onTitle: subscribe('title'), onError: subscribe('error'), onActivity: subscribe('activity')
  }
  let panel!: ChatPanel
  function Fixture() {
    panel = useConversationPanel(transport, scope)
    return createElement('span', null, panel.tabs[0]?.title || 'New chat')
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Fixture)))
  await act(async () => panel.startNew())
  return { panel: () => panel, create, send, commit, stored, events, container }
}

describe.each(['chat', 'project', 'authoring'] as const)('%s immediate send feedback', scope => {
  it('shows the first question and title before creation or send resolves, then replaces the local message once', async () => {
    const f = await fixture(scope)
    const originalCreate = f.create.getMockImplementation()!
    const creation = deferred<void>(), sent = deferred<void>()
    f.create.mockImplementationOnce(async () => { await creation.promise; return originalCreate() })
    f.send.mockImplementationOnce(async (id, text) => { await sent.promise; return f.commit(id, text) })
    const text = 'Explain this course in a book-like voice'
    const quote = { text: 'Selected passage', from: 'preview' as const }
    let sending!: Promise<boolean>
    await act(async () => { sending = f.panel().send(text, quote) })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.container.textContent).toBe(text)
    expect(f.panel().thread?.messages).toMatchObject([{ role: 'user', text, quote }])
    expect(f.panel().busy.has(f.panel().activeId!)).toBe(true)
    await act(async () => creation.resolve())
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.panel().activeId).toBe('saved')
    expect(f.container.textContent).toBe(text)
    expect(f.panel().thread?.messages).toHaveLength(1)
    await act(async () => { sent.resolve(); expect(await sending).toBe(true) })
    expect(f.panel().thread?.messages).toMatchObject([{ seq: 1, text }])
    expect(f.container.textContent).toBe(text)
    await act(async () => {
      f.stored.get('saved')!.chat.title = 'Improving the Course Narrative'
      f.events.title('saved', 'Improving the Course Narrative')
    })
    expect(f.container.textContent).toBe('Improving the Course Narrative')
    expect(f.panel().thread?.chat.title).toBe('Improving the Course Narrative')
  })

  it('rolls back a refused first send and keeps the empty draft available', async () => {
    const f = await fixture(scope), result = deferred<ChatSendResult>()
    const draft = f.panel().activeId
    f.send.mockImplementationOnce(() => result.promise)
    let sending!: Promise<boolean>
    await act(async () => { sending = f.panel().send('First question') })
    expect(f.panel().thread?.messages).toHaveLength(1)
    await act(async () => { result.resolve({ status: 'failed', message: 'Connection unavailable' }); expect(await sending).toBe(false) })
    expect(f.panel().activeId).toBe(draft)
    expect(f.panel().thread?.messages).toEqual([])
    expect(f.container.textContent).toBe('New chat')
    expect(f.panel().busy.size).toBe(0)
    expect(f.stored.size).toBe(0)
    expect(f.panel().error).toBe('Connection unavailable')
  })

  it('applies an early generated title before send acknowledgement and retains it when the thread loads', async () => {
    const f = await fixture(scope), acknowledgement = deferred<void>()
    f.send.mockImplementationOnce(async (id, text) => {
      const result = f.commit(id, text)
      await acknowledgement.promise
      return result
    })
    let sending!: Promise<boolean>
    await act(async () => { sending = f.panel().send('Make the course easier to read') })
    expect(f.container.textContent).toBe('Make the course easier to read')
    await act(async () => {
      f.stored.get('saved')!.chat.title = 'Readable Course Lessons'
      f.events.title('saved', 'Readable Course Lessons')
    })
    expect(f.container.textContent).toBe('Readable Course Lessons')
    expect(f.panel().busy.has('saved')).toBe(true)
    await act(async () => { acknowledgement.resolve(); expect(await sending).toBe(true) })
    expect(f.container.textContent).toBe('Readable Course Lessons')
    expect(f.panel().thread?.chat.title).toBe('Readable Course Lessons')
    expect(f.panel().thread?.messages).toHaveLength(1)
  })

  it('clears the pending message when chat creation fails and allows another attempt', async () => {
    const f = await fixture(scope)
    const draft = f.panel().activeId
    f.create.mockRejectedValueOnce(new Error('Could not create chat'))
    await act(async () => { expect(await f.panel().send('Question')).toBe(false) })
    expect(f.panel().activeId).toBe(draft)
    expect(f.panel().thread?.messages).toEqual([])
    expect(f.panel().busy.size).toBe(0)
    expect(f.container.textContent).toBe('New chat')
    expect(f.send).not.toHaveBeenCalled()
    await act(async () => { expect(await f.panel().send('Try again')).toBe(true) })
    expect(f.panel().thread?.messages).toMatchObject([{ text: 'Try again' }])
  })

  it('shows repeat follow-ups immediately, retains the original title, and avoids duplicate messages on early completion', async () => {
    const f = await fixture(scope)
    await act(async () => { await f.panel().send('Question') })
    await act(async () => f.events.done('saved'))
    const result = deferred<ChatSendResult>()
    f.send.mockImplementationOnce(() => result.promise)
    let sending!: Promise<boolean>
    await act(async () => { sending = f.panel().send('Question') })
    expect(f.panel().thread?.messages).toHaveLength(2)
    expect(f.container.textContent).toBe('Question')
    await act(async () => { expect(await f.panel().send('Duplicate send')).toBe(false) })
    expect(f.send).toHaveBeenCalledTimes(2)
    const accepted = f.commit('saved', 'Question')
    await act(async () => f.events.done('saved'))
    expect(f.panel().thread?.messages).toHaveLength(2)
    await act(async () => { result.resolve(accepted); expect(await sending).toBe(true) })
    expect(f.panel().thread?.messages).toHaveLength(2)
    expect(f.panel().busy.size).toBe(0)
    expect(f.panel().streaming).toBeNull()
  })
})
