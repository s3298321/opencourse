import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProvider, ChatModel, TitleGenerationConfig, TitleGenerationSettings } from '../src/core/types'
import TitleGenerationSection from '../src/renderer/components/TitleGenerationSettings'

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom does not implement the animation inventory used to anchor menus.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] })
  let config: TitleGenerationConfig | null = null
  const catalogs: Record<AIProvider, ChatModel[]> = {
    apiKey: [{ id: 'gpt-5.1', label: 'GPT-5.1', reasoningEfforts: ['low', 'high'] }, { id: 'gpt-4.1', label: 'GPT-4.1', reasoningEfforts: [] }],
    chatgpt: [{ id: 'gpt-5.3-codex', label: 'Codex', reasoningEfforts: ['low', 'high'] }]
  }
  const get = vi.fn(async (provider: AIProvider = config?.provider ?? 'apiKey'): Promise<TitleGenerationSettings> => ({
    config: config && { ...config }, provider, models: catalogs[provider], source: 'api', connection: { provider, ready: true }
  }))
  const save = vi.fn(async (next: TitleGenerationConfig | null) => { config = next })
  vi.stubGlobal('opencourse', { getTitleGenerationSettings: get, setTitleGenerationSettings: save })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(TitleGenerationSection, { version: 0 })))
  const select = async (selector: string, value: string) => {
    const field = container.querySelector<HTMLSelectElement>(selector)!
    await act(async () => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const provider = async (name: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.settings-title-provider')!.click())
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')].find(button => button.textContent?.includes(name))!
    await act(async () => choice.click())
  }
  return { container, save, get, select, provider, catalogs }
}

describe('title generation settings', () => {
  it('selects connection, model and reasoning independently, and can restore conversation settings', async () => {
    const f = await fixture()
    expect(f.container.querySelector<HTMLSelectElement>('.settings-title-model')!.disabled).toBe(true)
    await f.provider('OpenAI API key')
    expect(f.save).toHaveBeenLastCalledWith({ provider: 'apiKey', model: 'gpt-5.1', reasoning: 'low' })
    expect(f.container.querySelector('.settings-title-provider svg')).not.toBeNull()
    await f.select('.settings-title-reasoning', 'high')
    expect(f.save).toHaveBeenLastCalledWith({ provider: 'apiKey', model: 'gpt-5.1', reasoning: 'high' })
    await f.select('.settings-title-model', 'gpt-4.1')
    expect(f.save).toHaveBeenLastCalledWith({ provider: 'apiKey', model: 'gpt-4.1', reasoning: null })
    expect(f.container.querySelector<HTMLSelectElement>('.settings-title-reasoning')!.disabled).toBe(true)
    await f.provider('ChatGPT subscription')
    expect(f.save).toHaveBeenLastCalledWith({ provider: 'chatgpt', model: 'gpt-5.3-codex', reasoning: 'low' })
    await f.select('.settings-title-reasoning', '')
    expect(f.save).toHaveBeenLastCalledWith({ provider: 'chatgpt', model: 'gpt-5.3-codex', reasoning: null })
    await f.provider('Use chat settings')
    expect(f.save).toHaveBeenLastCalledWith(null)
    expect(f.container.querySelector<HTMLSelectElement>('.settings-title-model')!.disabled).toBe(true)
  })
  it('retains saved settings if another connection has no models or saving fails', async () => {
    const f = await fixture()
    await f.provider('OpenAI API key')
    f.catalogs.chatgpt = []
    await f.provider('ChatGPT subscription')
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.container.querySelector('[role=alert]')?.textContent).toContain('No title models')
    expect(f.container.querySelector('.settings-title-provider')?.getAttribute('aria-label')).toContain('OpenAI API key')
    f.save.mockRejectedValueOnce(new Error('Could not save settings'))
    await f.select('.settings-title-reasoning', 'high')
    expect(f.container.querySelector<HTMLSelectElement>('.settings-title-reasoning')!.value).toBe('low')
    expect(f.container.querySelector('[role=alert]')?.textContent).toBe('Could not save settings')
  })
})
