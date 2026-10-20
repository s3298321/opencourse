import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ServerReadingChat, serverMessage } from '../src/renderer/learning/ServerReadingChat'
import type { LearningChatView, LearningMessage } from '../src/core/learning/types'

vi.mock('../src/renderer/components/Html', () => ({ default: ({ source }: { source: string }) => createElement('div', null, source) }))
let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  localStorage.clear()
  vi.unstubAllGlobals()
})
const source = { kind: 'course' as const, id: 'published-course', version: '1' }
async function fixture(configured = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.getAnimations = () => []
  // No local AI or chat bridge is installed: any accidental local fallback fails.
  const view: LearningChatView = { chat: { id: 'server-chat', kind: 'course', contentId: source.id,
    version: '1', title: '', createdAt: '2026-10-21T00:00:00Z', messages: 0 }, messages: [] }
  const request = vi.fn(async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path === '/me/ai') return { configured, enabled: true, model: 'gpt-5', reasoning: 'high', webSearch: true }
    if (path.includes('?')) return { chats: [] }
    if (path.endsWith('/cancel')) return {}
    if (path.endsWith('/messages') && method === 'POST') {
      view.messages = [
        { id: 'q', chatId: view.chat.id, role: 'user', text: body.text, status: 'complete', at: view.chat.createdAt, citations: [] },
        { id: 'a', chatId: view.chat.id, role: 'assistant', text: '**Server answer**', status: 'running', at: view.chat.createdAt, citations: [] }
      ]
      view.chat.messages = 2
      view.chat.running = true
      return {}
    }
    return structuredClone(view)
  })
  const onClose = vi.fn(), onAddKey = vi.fn(), onQuoteUsed = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(createElement(ServerReadingChat, {
    client: { request }, source, draftKey: 'server/account/course', localId: 'local-course',
    quote: { from: 'lesson', text: 'Selected passage' }, onClose, onAddKey, onQuoteUsed
  })))
  const input = el.querySelector<HTMLTextAreaElement>('.sidechat-input')!
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { el, input, type, request, onClose, onAddKey, onQuoteUsed }
}

it('uses the local chat UI while sending and stopping exclusively through the server', async () => {
  const f = await fixture()
  expect(f.el.querySelector('.sidechat')).not.toBeNull()
  expect(f.el.querySelector('.learning-chat')).toBeNull()
  expect(f.input.rows).toBe(1)
  expect(f.el.querySelector('.sidechat-model')?.textContent).toContain('gpt-5')
  expect(f.el.querySelector('.sidechat-quote')?.textContent).toContain('Selected passage')
  await f.type('Explain this')
  await act(async () => f.el.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click())
  expect(f.request).toHaveBeenCalledWith('/learning/chats', 'POST', source)
  expect(f.request).toHaveBeenCalledWith('/learning/chats/server-chat/messages', 'POST', {
    text: 'Explain this', quote: 'Selected passage', requestId: expect.any(String)
  })
  expect(f.onQuoteUsed).toHaveBeenCalledOnce()
  expect(f.el.querySelector('.partial')?.textContent).toContain('Server answer')
  await act(async () => f.el.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click())
  expect(f.request).toHaveBeenCalledWith('/learning/chats/server-chat/cancel', 'POST', {})
  await act(async () => f.el.querySelector<HTMLButtonElement>('.sidechat-close')!.click())
  expect(f.onClose).toHaveBeenCalledOnce()
})

it('blocks sending without the server connection and opens server settings from the shared controls', async () => {
  const f = await fixture(false)
  await f.type('Question')
  expect(f.el.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(true)
  await act(async () => f.el.querySelector<HTMLButtonElement>('.sidechat-note button')!.click())
  expect(f.onAddKey).toHaveBeenCalledOnce()
  await act(async () => f.el.querySelector<HTMLButtonElement>('.sidechat-connection')!.click())
  expect(document.body.textContent).toContain('Server settings')
  expect(document.body.textContent).not.toContain('ChatGPT')
  expect(f.request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
})

it('preserves failed replies and maps server citations to local reading destinations', () => {
  const message: LearningMessage = { id: 'a', chatId: 'chat', role: 'assistant', text: 'Partial answer', status: 'interrupted',
    at: '2026-10-21T00:00:00Z', citations: [{ title: 'Lesson', moduleId: 'module', lessonId: 'lesson' }, { title: 'Reference', url: 'https://example.com' }] }
  expect(serverMessage(message, 2, source, 'installed-course')).toMatchObject({
    seq: 2, text: 'Partial answer', status: 'stopped',
    localSources: [{ kind: 'course', courseId: 'installed-course', moduleId: 'module', lessonId: 'lesson', title: 'Lesson' }],
    citations: [{ title: 'Reference', url: 'https://example.com', start: -1, end: -1 }]
  })
})
