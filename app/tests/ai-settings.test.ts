import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIModelSettings, AIProfile } from '../src/core/types'
import { AIModelsSection } from '../src/renderer/components/AISettings'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('allowed model bulk selection', () => {
  it.each(['chat', 'project', 'authoring'] as const)('clears and restores the full %s catalog while filtered, then selects a new default', async scope => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const settings: AIModelSettings = {
      scope, provider: 'apiKey', selectedProvider: 'apiKey', source: 'api', webSearch: false,
      connection: { provider: 'apiKey', ready: true },
      models: Array.from({ length: 9 }, (_, i) => ({ id: `gpt-test-${i}`, label: `Model ${i}`, reasoningEfforts: ['low'] })),
      profile: { enabledModels: null, defaultModel: 'gpt-test-0', defaultReasoning: 'low' }
    }
    const save = vi.fn(async (_scope, _provider, profile: AIProfile) => { settings.profile = profile })
    vi.stubGlobal('opencourse', {
      getAIModelSettings: vi.fn(async () => structuredClone(settings)), setAIProfile: save
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(AIModelsSection, { scope, version: 0 })))
    const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!
    const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    const filter = container.querySelector<HTMLInputElement>('.settings-filter')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'Model 8')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(checkboxes()).toHaveLength(1)
    await act(async () => button('.settings-models-unselect-all').click())
    expect(save).toHaveBeenLastCalledWith(scope, 'apiKey', { enabledModels: [], defaultModel: null, defaultReasoning: null })
    expect(checkboxes()[0].checked).toBe(false)
    expect(button('.settings-models-unselect-all').disabled).toBe(true)
    expect(container.querySelector<HTMLSelectElement>(`.settings-default-${scope}-model`)!.disabled).toBe(true)
    await act(async () => button('.settings-models-select-all').click())
    expect(save).toHaveBeenLastCalledWith(scope, 'apiKey', { enabledModels: null, defaultModel: 'gpt-test-0', defaultReasoning: null })
    expect(checkboxes()[0].checked).toBe(true)
    expect(button('.settings-models-select-all').disabled).toBe(true)
    await act(async () => button('.settings-models-unselect-all').click())
    await act(async () => checkboxes()[0].click())
    expect(save).toHaveBeenLastCalledWith(scope, 'apiKey', { enabledModels: ['gpt-test-8'], defaultModel: 'gpt-test-8', defaultReasoning: null })
  })
})

it('toggles authoring research independently and restores the checkbox on failure', async () => {
  const { WebSearchSection } = await import('../src/renderer/routes/Settings')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const setAuthoring = vi.fn(async (on: boolean) => on), setChat = vi.fn(async (on: boolean) => on)
  vi.stubGlobal('opencourse', { getAuthoringWebSearch: async () => true, setAuthoringWebSearch: setAuthoring, getChatWebSearch: async () => false, setChatWebSearch: setChat })
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(WebSearchSection, { authoring: true })))
  const checkbox = container.querySelector<HTMLInputElement>('.settings-authoring-web-search')!
  expect(checkbox.checked).toBe(true)
  await act(async () => checkbox.click())
  expect(setAuthoring).toHaveBeenCalledWith(false); expect(setChat).not.toHaveBeenCalled()
  expect(checkbox.checked).toBe(false)
  setAuthoring.mockRejectedValueOnce(new Error('Could not save'))
  await act(async () => checkbox.click())
  expect(checkbox.checked).toBe(false)
  expect(container.textContent).toContain('Could not save')
})

it.each(['chat', 'project', 'authoring'] as const)('hides %s model controls after disconnecting, even with a saved catalog', async scope => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const settings: AIModelSettings = {
    scope, provider: 'apiKey', selectedProvider: 'apiKey', source: 'cache', webSearch: false,
    connection: { provider: 'apiKey', ready: true, message: 'Add an OpenAI API key in Settings.' },
    models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }],
    profile: { enabledModels: null, defaultModel: 'gpt-5.1', defaultReasoning: 'low' }
  }
  vi.stubGlobal('opencourse', { getAIModelSettings: async () => structuredClone(settings) })
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(AIModelsSection, { scope, version: 0 })))
  expect(container.querySelector('select')).not.toBeNull()
  settings.connection.ready = false
  await act(async () => root!.render(createElement(AIModelsSection, { scope, version: 1 })))
  expect(container.querySelector('select')).toBeNull()
  expect(container.querySelector('input[type=checkbox]')).toBeNull()
  expect(container.textContent).toContain(settings.connection.message)
  expect(container.textContent).not.toContain('GPT-5.1')
})
