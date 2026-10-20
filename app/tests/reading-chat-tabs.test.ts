import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useReadingTabs } from '../src/learning-ui/useReadingTabs'
import type { LearningClient } from '../src/learning-ui/client'
import type { LearningChatView } from '../src/core/learning/types'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  localStorage.clear()
  vi.unstubAllGlobals()
})
const source = { kind: 'course' as const, id: 'course', version: '1' }
function conversation(id: string, messages = 1): LearningChatView {
  return {
    chat: {
      id,
      kind: 'course',
      contentId: 'course',
      version: '1',
      title: `Question ${id}`,
      createdAt: '2026-10-19',
      messages
    },
    messages: messages
      ? [
          {
            id: `${id}-1`,
            chatId: id,
            role: 'user',
            text: `Question ${id}`,
            status: 'complete',
            at: '2026-10-19',
            citations: []
          }
        ]
      : []
  }
}
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const stored = new Map(['one', 'two'].map((id) => [id, conversation(id)]))
  const creates = vi.fn(async () => {
    const view = conversation('created', 0)
    stored.set('created', view)
    return structuredClone(view)
  })
  const send = vi.fn(async (id: string, body: { text: string; requestId: string }) => {
    const view = stored.get(id)!
    if (!view.messages.some((m) => m.id === body.requestId))
      view.messages.push({
        id: body.requestId,
        chatId: id,
        role: 'user',
        text: body.text,
        status: 'complete',
        at: 'now',
        citations: []
      })
    view.chat.messages = view.messages.length
    view.chat.title = body.text
    return {}
  })
  const get = vi.fn(async (id: string) => structuredClone(stored.get(id)!))
  const remove = vi.fn(async (id: string) => {
    stored.delete(id)
    return {}
  })
  const request = vi.fn(async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.includes('?')) return { chats: [...stored.values()].map((v) => structuredClone(v.chat)) }
    if (method === 'DELETE') return remove(path.split('/')[3])
    if (path === '/learning/chats') return creates()
    if (method === 'POST') return send(path.split('/')[3], body)
    return get(path.split('/')[3])
  })
  const client: LearningClient = { request }
  let panel!: ReturnType<typeof useReadingTabs>
  function Fixture() {
    panel = useReadingTabs(client, source, 'test')
    return null
  }
  async function mount() {
    const el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    await act(async () => root!.render(createElement(Fixture)))
  }
  await mount()
  return { panel: () => panel, mount, creates, send, get, remove, stored }
}
it('uses local drafts, keeps closed conversations in history, and restores saved tabs', async () => {
  const f = await fixture()
  expect(f.panel().active).toBe('one')
  await act(async () => f.panel().startNew())
  const draft = f.panel().active
  await act(async () => f.panel().setText('Draft question'))
  await act(async () => f.panel().open('two'))
  expect(f.panel().text).toBe('')
  await act(async () => f.panel().open(draft))
  expect(f.panel().text).toBe('Draft question')
  expect(f.creates).not.toHaveBeenCalled()
  expect(f.panel().chats).toHaveLength(2)
  await act(async () => f.panel().close(draft))
  await act(async () => f.panel().close('one'))
  expect(f.panel().chats).toHaveLength(2)
  expect(f.remove).not.toHaveBeenCalled()
  await act(async () => root!.unmount())
  root = undefined
  await f.mount()
  expect(f.panel().tabs).toEqual(['two'])
  await act(async () => f.panel().close('two'))
  expect(f.panel().active).toMatch(/^draft:/)
  expect(f.creates).not.toHaveBeenCalled()
})
it('creates only on first send and retries a dropped acknowledgment in the same conversation', async () => {
  const f = await fixture()
  await act(async () => f.panel().startNew())
  await act(async () => f.panel().setText('Explain this'))
  const ordinary = f.send.getMockImplementation()!
  f.send.mockImplementationOnce(async (...args) => {
    await ordinary(...args)
    throw new Error('Connection lost')
  })
  await act(async () => {
    expect(await f.panel().send()).toBe(false)
  })
  expect(f.creates).toHaveBeenCalledTimes(1)
  expect(f.panel().active).toBe('created')
  expect(f.panel().text).toBe('Explain this')
  await act(async () => root!.unmount())
  root = undefined
  await f.mount()
  expect(f.panel().active).toBe('created')
  await act(async () => {
    expect(await f.panel().send()).toBe(true)
  })
  expect(f.send.mock.calls[1]).toEqual(f.send.mock.calls[0])
  expect(f.creates).toHaveBeenCalledTimes(1)
  expect(f.stored.get('created')!.messages).toHaveLength(1)
  expect(f.panel().text).toBe('')
})
it('does not let a delayed history load replace the selected tab', async () => {
  const f = await fixture()
  let resolve!: (value: LearningChatView) => void
  f.get.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await act(async () => f.panel().open('two'))
  await act(async () => f.panel().open('one'))
  await act(async () => resolve(conversation('two')))
  expect(f.panel().active).toBe('one')
  expect(f.panel().view?.chat.id).toBe('one')
})
it('removes saved history and its tab only after deletion succeeds', async () => {
  const f = await fixture()
  f.remove.mockRejectedValueOnce(new Error('Offline'))
  await act(async () => f.panel().remove('one'))
  expect(f.panel().chats.map((c) => c.id)).toContain('one')
  await act(async () => f.panel().remove('one'))
  expect(f.panel().chats.map((c) => c.id)).not.toContain('one')
  expect(f.panel().tabs.every((id) => id.startsWith('draft:'))).toBe(true)
})
