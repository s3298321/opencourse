import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanelView from '../src/renderer/components/ChatPanel'
import type { ChatPanel, PanelSummary } from '../src/renderer/sidechat/useChat'
import { CHATGPT_USAGE_LIMIT, OPENAI_OVERLOADED } from '../src/core/ai-errors'

vi.mock('../src/renderer/markdown-context', () => ({
  useMarkdown: () => ({ render: (text: string) => text, renderInline: (text: string) => text })
}))

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  targets = new Set<Element>()
  constructor(readonly callback: () => void) { ResizeObserverMock.instances.push(this) }
  observe(target: Element) { this.targets.add(target) }
  disconnect() { this.targets.clear() }
}

let root: Root
let container: HTMLDivElement
let panel: ChatPanel
let visible: boolean
let variant: 'lesson' | 'project' | 'authoring'
let scroller: HTMLDivElement
let height: number
let viewport: number
let top: number

function chat(id: string): PanelSummary {
  return { id, title: 'Chat', model: '', provider: 'apiKey', reasoning: null, courseId: 'course', messages: 1, createdAt: 'now', updatedAt: 'now' }
}
async function render() {
  await act(async () => root.render(createElement(ChatPanelView, {
    panel, visible, variant, quote: null, onQuoteUsed: vi.fn(), onAddKey: vi.fn()
  })))
}
const latest = () => container.querySelector<HTMLButtonElement>('.sidechat-latest')
async function scroll(to: number) {
  await act(async () => {
    scroller.scrollTop = to
    scroller.dispatchEvent(new Event('scroll'))
  })
}
async function resize(target: Element) {
  await act(async () => {
    for (const observer of ResizeObserverMock.instances) {
      if (observer.targets.has(target)) observer.callback()
    }
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  ResizeObserverMock.instances = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  visible = true
  variant = 'lesson'
  const summary = chat('one')
  panel = {
    chats: [summary], tabs: [summary], activeId: summary.id,
    thread: { chat: summary, messages: [{ seq: 0, role: 'user', text: 'Explain this', at: '2026-10-10T12:00:00Z' }] },
    streaming: 'Beginning of the answer', busy: new Set([summary.id]), error: null,
    models: [], webSearch: false, ready: true, connectionLoading: false, provider: 'apiKey',
    connection: { provider: 'apiKey', ready: true }, defaultProvider: 'apiKey', connections: {},
    loading: false, activity: null, toolRunning: false, setActive: vi.fn(), open: vi.fn(), close: vi.fn(),
    startNew: vi.fn(), resume: vi.fn(), remove: vi.fn(), send: vi.fn(), stop: vi.fn(),
    setModel: vi.fn(), setReasoning: vi.fn(), setProvider: vi.fn()
  }
  await render()
  scroller = container.querySelector<HTMLDivElement>('.sidechat-scroll')!
  height = 1000
  viewport = 300
  top = 0
  // jsdom has no layout; emulate the browser's metrics and clamped scrollTop.
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - viewport)) } }
  })
  await resize(scroller)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('chat connection status', () => {
  it.each(['lesson', 'project', 'authoring'] as const)('shows a loader while %s connection details are pending, then removes it when ready', async kind => {
    variant = kind
    panel = { ...panel, ready: false, connectionLoading: true }
    await render()
    const status = container.querySelector('.sidechat-connection-loading')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Checking AI connection…')
    expect(status.querySelector('.sidechat-connection-spinner')).not.toBeNull()
    expect(container.textContent).not.toContain('Open Settings')
    panel = { ...panel, ready: true, connectionLoading: false }
    await render()
    expect(container.querySelector('.sidechat-note')).toBeNull()
  })

  it('only offers setup after the connection check confirms it is required', async () => {
    panel = { ...panel, ready: false, connectionLoading: false,
      connection: { provider: 'apiKey', ready: false, message: 'Connect OpenAI in Settings.' } }
    await render()
    expect(container.querySelector('.sidechat-connection-loading')).toBeNull()
    expect(container.querySelector('.sidechat-note')?.textContent).toBe('Connect OpenAI in Settings.Open Settings')
  })
})

describe('chat history', () => {
  it.each(['one', 'two'])('collapses history when selecting chat %s, including the current chat', async id => {
    panel = { ...panel, chats: [chat('one'), chat('two')] }
    await render()
    const toggle = container.querySelector<HTMLButtonElement>('.sidechat-history-toggle')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = container.querySelectorAll<HTMLDivElement>('.sidechat-history-row')
    await act(async () => rows[id === 'one' ? 0 : 1].click())
    expect(panel.open).toHaveBeenCalledWith(id)
    expect(container.querySelector('.sidechat-history')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows each chat’s last message date and time, omitting missing or invalid dates', async () => {
    const at = '2026-10-05T20:10:00.000Z'
    panel = { ...panel, chats: [
      { ...chat('one'), lastMessageAt: at, updatedAt: '2026-10-15T12:00:00Z' },
      { ...chat('two'), lastMessageAt: null },
      { ...chat('three'), lastMessageAt: 'invalid' }
    ] }
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('.sidechat-history-toggle')!.click())
    const times = container.querySelectorAll<HTMLTimeElement>('.sidechat-history time')
    expect(times).toHaveLength(1)
    expect(times[0].dateTime).toBe(at)
    expect(times[0].textContent).toContain('2026')
    expect(times[0].textContent).toMatch(/\d{2}:\d{2}/)
    expect(times[0].getAttribute('aria-label')).toContain('Last message:')
    expect(times[0].title).toContain('2026')
  })

  it('keeps history open when deleting a chat', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await act(async () => container.querySelector<HTMLButtonElement>('.sidechat-history-toggle')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.sidechat-history-row button')!.click())
    expect(panel.remove).toHaveBeenCalledWith('one')
    expect(panel.open).not.toHaveBeenCalled()
    expect(container.querySelector('.sidechat-history')).not.toBeNull()
    vi.mocked(window.confirm).mockRestore()
  })
})

describe('web citation display', () => {
  it('hides internal references in saved answers and incomplete streaming tokens', async () => {
    panel = { ...panel,
      thread: { chat: chat('one'), messages: [{ seq: 0, role: 'assistant', at: '2026-10-15T12:00:00Z', text: 'Saved answer.\uE200cite\uE202turn1view0\uE201' }] },
      streaming: 'Live answer.\uE200cite\uE202turn2view'
    }
    await render()
    const answers = [...container.querySelectorAll('.chat-turn.assistant .chat-body')].map(answer => answer.textContent)
    expect(answers).toEqual(['Saved answer.', 'Live answer.'])
  })
})

describe('chat error actions', () => {
  it('shows a clear overload message and a guarded retry instead of usage and settings links', async () => {
    const retry = vi.fn(async () => true)
    panel = { ...panel, provider: 'chatgpt', busy: new Set(), streaming: null, error: 'Our servers are currently overloaded. (server_is_overloaded)', retry }
    await render()
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toBe(`${OPENAI_OVERLOADED} Retry`)
    const button = alert.querySelector('button')!
    await act(async () => button.click())
    expect(retry).toHaveBeenCalledOnce()
    panel = { ...panel, sendBlocked: true }
    await render()
    expect(container.querySelector<HTMLButtonElement>('[role="alert"] button')!.disabled).toBe(true)
  })

  it('keeps usage management for a ChatGPT plan limit', async () => {
    panel = { ...panel, provider: 'chatgpt', busy: new Set(), streaming: null, error: CHATGPT_USAGE_LIMIT }
    await render()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Manage usage')
    expect(container.querySelector('[role="alert"]')!.textContent).not.toContain('Retry')
  })
})

describe('chat streaming scroll', () => {
  it.each(['lesson', 'project', 'authoring'] as const)('pauses %s chat when reading above and resumes from the floating button', async kind => {
    variant = kind
    await render()
    expect(top).toBe(700)
    expect(latest()).toBeNull()
    height = 1200
    panel = { ...panel, streaming: panel.streaming + '\nMore of the answer' }
    await render()
    expect(top).toBe(900)
    await scroll(450)
    expect(latest()?.getAttribute('aria-label')).toBe('Scroll to latest response')
    height = 1500
    panel = { ...panel, streaming: panel.streaming + '\nThe answer continues offscreen' }
    await render()
    expect(top).toBe(450)
    expect(container.querySelector('.partial')?.textContent).toContain('continues offscreen')
    await act(async () => latest()!.click())
    expect(top).toBe(1200)
    expect(latest()).toBeNull()
    height = 1700
    panel = { ...panel, streaming: panel.streaming + '\nFollowing again' }
    await render()
    expect(top).toBe(1400)
  })

  it('releases follow even for a small upward scroll', async () => {
    await scroll(690)
    height = 1100
    panel = { ...panel, streaming: 'More text' }
    await render()
    expect(top).toBe(690)
    expect(latest()).not.toBeNull()
  })

  it('does not pull the reader down if a delta arrives before their scroll event', async () => {
    scroller.scrollTop = 400
    height = 1100
    panel = { ...panel, streaming: 'Next delta' }
    await render()
    expect(top).toBe(400)
    expect(latest()).not.toBeNull()
  })

  it('does not treat growing content with an unchanged offset as scrolling up', async () => {
    height = 1200
    await scroll(700)
    expect(latest()).toBeNull()
    await resize(scroller.firstElementChild!)
    expect(top).toBe(900)
  })

  it('follows viewport and content resizing only while following', async () => {
    viewport = 250
    await resize(scroller)
    expect(top).toBe(750)
    height = 1300
    await resize(scroller.firstElementChild!)
    expect(top).toBe(1050)
    await scroll(350)
    viewport = 200
    height = 1500
    await resize(scroller)
    await resize(scroller.firstElementChild!)
    expect(top).toBe(350)
    expect(latest()).not.toBeNull()
  })

  it('preserves the reading position when the partial becomes a finished response', async () => {
    await scroll(400)
    panel = { ...panel, streaming: null, busy: new Set(), thread: {
      ...panel.thread!, messages: [...panel.thread!.messages, {
        seq: 1, role: 'assistant', text: 'Finished answer', at: '2026-10-10T12:01:00Z'
      }]
    } }
    await render()
    expect(top).toBe(400)
    expect(latest()).not.toBeNull()
    expect(container.querySelector('.chat-answer')?.textContent).toBe('Finished answer')
  })

  it('resumes when the reader scrolls back to the bottom', async () => {
    await scroll(400)
    await scroll(700)
    expect(latest()).toBeNull()
    height = 1200
    panel = { ...panel, streaming: 'More' }
    await render()
    expect(top).toBe(900)
  })

  it('starts following when another conversation is selected', async () => {
    await scroll(400)
    const summary = chat('two')
    panel = { ...panel, activeId: summary.id, tabs: [...panel.tabs, summary], thread: { chat: summary, messages: [] } }
    await render()
    expect(top).toBe(700)
    expect(latest()).toBeNull()
  })

  it('settles message entrances while hidden so reopening shows history immediately', async () => {
    panel = { ...panel, thread: { ...panel.thread!, messages: [...panel.thread!.messages, {
      seq: 1, role: 'user', text: 'A new question', at: '2026-10-15T12:00:00Z'
    }] } }
    await render()
    expect(container.querySelector('.chat-turn.user.enter')).not.toBeNull()
    visible = false
    await render()
    visible = true
    await render()
    expect(container.querySelector('.chat-turn.user.enter')).toBeNull()
    expect([...container.querySelectorAll('.chat-bubble')].at(-1)?.textContent).toBe('A new question')
  })

  it('keeps a paused reading position through hidden updates and revealing the panel', async () => {
    await scroll(400)
    visible = false
    await render()
    await scroll(0) // Hidden panes can emit layout-induced scroll events.
    height = 1300
    panel = { ...panel, streaming: 'Background output' }
    await render()
    expect(top).toBe(0)
    scroller.scrollTop = 400 // The persistent screen host restores its position.
    visible = true
    await render()
    await resize(scroller)
    expect(top).toBe(400)
    expect(latest()).not.toBeNull()
  })
})

it('shows authoring web availability and keeps consulted sources distinct, safe and deduplicated', async () => {
  variant = 'authoring'; panel.busy = new Set(); panel.streaming = null; panel.webSearch = true
  panel.models = [{ id: 'gpt-5.6-terra', label: 'GPT' }]; panel.thread!.chat.model = 'gpt-5.6-terra'
  panel.thread!.messages = [{ seq: 1, role: 'assistant', text: 'Updated', at: '2026-10-15T12:00:00Z',
    citations: [{ url: 'https://docs.python.org/', title: 'Python', start: -1, end: -1 }],
    researchSources: [{ url: 'https://docs.python.org/', title: 'Duplicate' }, { url: 'https://peps.python.org/', title: 'PEPs' }, { url: 'javascript:alert(1)', title: 'Unsafe' }] }]
  panel.thread = { ...panel.thread! }
  await render()
  expect(container.querySelector('[aria-label="Can search the web"]')).not.toBeNull()
  const consulted = container.querySelector<HTMLDetailsElement>('[aria-label="Other research sources"]')!
  expect(consulted.open).toBe(false)
  expect(consulted.querySelector('summary')?.textContent).toBe('Other research sources (1)')
  expect(consulted.querySelectorAll('a')).toHaveLength(1)
  expect(consulted.querySelector('a')?.href).toBe('https://peps.python.org/')
  const cited = container.querySelector('[aria-label="Cited sources"]')!
  expect(cited.querySelector('.chat-sources-label')?.textContent).toBe('Cited sources')
  expect(cited.textContent).toContain('Python')
  expect(container.innerHTML).not.toContain('javascript:')
})
