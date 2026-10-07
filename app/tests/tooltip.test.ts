import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tooltip from '../src/renderer/components/Tooltip'
import ConnectionIcon from '../src/renderer/components/ConnectionIcon'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(label: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  container.style.overflow = 'hidden'
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Tooltip, {
    label,
    children: createElement('span', { className: 'sidechat-connection', role: 'img', 'aria-label': label, tabIndex: 0 }, createElement(ConnectionIcon, { provider: 'chatgpt' }))
  })))
  return container.querySelector<HTMLElement>('.sidechat-connection')!
}

describe('connection tooltips', () => {
  it('shows the connection and account on hover in a portal outside clipped containers, and hides on leave', async () => {
    vi.useFakeTimers()
    const trigger = await mount('ChatGPT subscription (Personal workspace)')
    expect(document.querySelector('[role=tooltip]')).toBeNull()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      vi.advanceTimersByTime(150)
    })
    const tooltip = document.querySelector<HTMLElement>('[role=tooltip]')!
    expect(tooltip.textContent).toBe('ChatGPT subscription (Personal workspace)')
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.style.visibility).toBe('visible')
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(trigger.hasAttribute('title')).toBe(false)
    await act(async () => trigger.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
    expect(document.querySelector('[role=tooltip]')).toBeNull()
  })

  it('shows immediately on keyboard focus and dismisses with Escape, scrolling, and blur', async () => {
    const trigger = await mount('OpenAI API key')
    await act(async () => trigger.focus())
    expect(document.querySelector('[role=tooltip]')?.textContent).toBe('OpenAI API key')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role=tooltip]')).toBeNull()
    await act(async () => { trigger.blur(); trigger.focus() })
    expect(document.querySelector('[role=tooltip]')).not.toBeNull()
    await act(async () => window.dispatchEvent(new Event('scroll')))
    expect(document.querySelector('[role=tooltip]')).toBeNull()
    await act(async () => { trigger.blur(); trigger.focus() })
    await act(async () => trigger.blur())
    expect(document.querySelector('[role=tooltip]')).toBeNull()
  })

  it('replaces a focused control’s tooltip when another icon is hovered', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement('div', null,
      createElement(Tooltip, { label: 'OpenAI API key', children: createElement('button', { id: 'key' }, 'Key') }),
      createElement(Tooltip, { label: 'ChatGPT subscription', children: createElement('span', { id: 'subscription', tabIndex: 0 }, 'OpenAI') })
    )))
    await act(async () => container.querySelector<HTMLElement>('#key')!.focus())
    expect(document.querySelector('[role=tooltip]')?.textContent).toBe('OpenAI API key')
    await act(async () => {
      container.querySelector('#subscription')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      vi.advanceTimersByTime(150)
    })
    expect(document.querySelectorAll('[role=tooltip]')).toHaveLength(1)
    expect(document.querySelector('[role=tooltip]')?.textContent).toBe('ChatGPT subscription')
    expect(container.querySelector('#key')!.hasAttribute('aria-describedby')).toBe(false)
  })
})
