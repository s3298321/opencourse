import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionSettings } from '../src/learning-ui/ConnectionSettings'
import type { LearningClient } from '../src/learning-ui/client'
import type { ServerAISettings } from '../src/core/learning/types'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function fixture(configured = false, enabled = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let settings: ServerAISettings = {
    configured, enabled, hint: configured ? 'test' : null,
    model: 'gpt-5.1', reasoning: 'low', title: null, webSearch: false
  }
  const request = vi.fn(async (path: string, method = 'GET', body?: Partial<ServerAISettings>) => {
    if (path === '/me/ai/models') return { models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }], source: 'api' }
    if (path === '/me/ai') {
      if (method === 'PUT') settings = { ...settings, ...body, configured: true, hint: 'test' }
      if (method === 'DELETE') settings = { ...settings, configured: false, hint: null }
      return { ...settings }
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  const client = { request } as LearningClient
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(ConnectionSettings, { client, username: 'Learner' })))
  return { container, request }
}

it.each([[false, true], [false, false], [true, false]])('hides server model controls when configured=%s and enabled=%s', async (configured, enabled) => {
  const { container, request } = await fixture(configured, enabled)
  expect(container.querySelector('select')).toBeNull()
  expect(container.querySelector('input[type=password]')).not.toBeNull()
  expect(request).not.toHaveBeenCalledWith('/me/ai/models')
})

it('reveals models after saving a key and hides them again on removal', async () => {
  const { container, request } = await fixture()
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save AI settings')!
  expect(save.disabled).toBe(true)
  const key = container.querySelector<HTMLInputElement>('input[type=password]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'sk-test')
    key.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(save.disabled).toBe(false)
  await act(async () => key.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(save.disabled).toBe(true)
  expect(request).toHaveBeenCalledWith('/me/ai/models')
  expect(container.querySelectorAll('select')).toHaveLength(4)
  const remove = [...container.querySelectorAll('button')].find(button => button.textContent === 'Remove API key')!
  await act(async () => remove.click())
  expect(container.querySelector('select')).toBeNull()
  expect(container.textContent).not.toContain('GPT-5.1')
  expect(save.disabled).toBe(true)
})

it('enables saving only for changed settings and resets after a successful save', async () => {
  const { container, request } = await fixture(true)
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save AI settings')!
  const webSearch = container.querySelector<HTMLInputElement>('input[type=checkbox]')!
  expect(save.disabled).toBe(true)
  await act(async () => webSearch.click())
  expect(save.disabled).toBe(false)
  await act(async () => webSearch.click())
  expect(save.disabled).toBe(true)
  await act(async () => webSearch.click())
  await act(async () => save.click())
  expect(request).toHaveBeenCalledWith('/me/ai', 'PUT', expect.objectContaining({ webSearch: true }))
  expect(save.disabled).toBe(true)
  await act(async () => webSearch.click())
  expect(save.disabled).toBe(false)
  request.mockRejectedValueOnce(new Error('Save failed'))
  await act(async () => save.click())
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Save failed')
  expect(save.disabled).toBe(false)
})
