import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/core/types'
import ChatMessageMeta from '../src/renderer/components/ChatMessageMeta'

function render(message: Pick<ChatMessage, 'at' | 'generation'>): HTMLDivElement {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(createElement(ChatMessageMeta, { message }))
  return container
}

describe('message timestamps and response attribution', () => {
  it('renders the stored timestamp as a semantic time with its full date, including for legacy messages', () => {
    const at = '2026-10-05T20:10:00.000Z'
    const container = render({ at })
    const time = container.querySelector('time')!
    expect(time.dateTime).toBe(at)
    expect(time.textContent).toMatch(/\d{2}:\d{2}/)
    expect(time.getAttribute('aria-label')).toContain('2026')
    expect(container.querySelector('.chat-generation')).toBeNull()
  })
  it.each([
    ['high', 'High reasoning'], ['xhigh', 'Extra high reasoning'], ['none', 'No reasoning'], [null, 'Default reasoning']
  ] as const)('shows the response’s recorded %s reasoning and model', (reasoning, label) => {
    const container = render({ at: '2026-10-05T20:10:00.000Z', generation: { model: 'gpt-6.1-sol', reasoning, provider: 'apiKey' } })
    expect(container.querySelector('.chat-generation')?.textContent).toContain('gpt-6.1-sol')
    expect(container.querySelector('.chat-generation')?.textContent).toContain(label)
    expect(container.querySelector('.chat-message-meta')?.getAttribute('data-ask')).toBe('none')
  })
  it('handles malformed legacy dates without rendering an invalid timestamp', () => {
    const container = render({ at: 'invalid' })
    expect(container.textContent).toBe('')
    expect(container.querySelector('time')).toBeNull()
  })
})
