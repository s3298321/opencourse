import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Route } from '../src/renderer/routes'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/components/ThemeSettings', () => ({ default: () => createElement('input', { 'aria-label': 'Theme filter', defaultValue: '' }) }))
import Settings from '../src/renderer/routes/Settings'

let root: Root
let container: HTMLDivElement
const user = { id: 'user', name: 'Learner', color: '#abc', createdAt: '2026-10-10T00:00:00Z' }
const about = { name: 'OpenCourse', description: 'Learn', version: '0.3.0', python: { version: '3.14.8', release: '20261003' }, electron: '44', chromium: '150', node: '22', platform: 'darwin', architecture: 'arm64', license: 'MIT', website: 'https://opencourse.dev' }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('opencourse', { onAIChanged: () => () => {}, getAppInfo: vi.fn(async () => about) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const render = async (route: Extract<Route, { name: 'settings' }> = { name: 'settings', from: { name: 'library' } }) => act(async () => root.render(createElement(Settings, { user, route, navigate: vi.fn(), onSession: vi.fn(), onSessionChanged: vi.fn() })))
const select = async (id: string) => act(async () => container.querySelector<HTMLButtonElement>(`[data-settings-category="${id}"]`)!.click())
describe('categorized Settings', () => {
  it('defaults to Profile, keeps visited inputs, and exposes three external links', async () => {
    await render()
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Profile')
    expect(container.querySelectorAll('.settings-category')).toHaveLength(9)
    const name = container.querySelector<HTMLInputElement>('.settings-name')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Unfinished name')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await select('appearance')
    const filter = container.querySelector<HTMLInputElement>('[aria-label="Theme filter"]')!
    filter.value = 'paper'
    await select('profile')
    expect(name.value).toBe('Unfinished name')
    await select('appearance')
    expect(container.querySelector('[aria-label="Theme filter"]')).toBe(filter)
    expect(filter.value).toBe('paper')
    expect([...container.querySelectorAll<HTMLAnchorElement>('.settings-links a')].map(a => a.href)).toEqual(['https://opencourse.dev/legal', 'https://opencourse.dev/', 'https://catalog.opencourse.dev/'])
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Appearance')
  })
  it('opens About directly and displays runtime metadata', async () => {
    await render({ name: 'settings', from: { name: 'library' }, section: 'about' })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('About')
    expect(container.querySelector('.settings-about')?.textContent).toContain('3.14.8')
    expect(container.querySelector('.settings-about')?.textContent).toContain('20261003')
    expect(container.querySelector('.settings-about')?.textContent).toContain('macOS')
    await select('profile')
    await render({ name: 'settings', from: { name: 'library' }, section: 'about' })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('About')
    expect(window.opencourse.getAppInfo).toHaveBeenCalledOnce()
  })
  it('can retry a failed read and still shows the app if Python is unavailable', async () => {
    vi.mocked(window.opencourse.getAppInfo).mockRejectedValueOnce(new Error('IPC unavailable')).mockResolvedValueOnce({ ...about, python: null })
    await render({ name: 'settings', from: { name: 'library' }, section: 'about' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('IPC unavailable')
    await act(async () => container.querySelector<HTMLButtonElement>('.settings-about button')!.click())
    expect(container.querySelector('.settings-about')?.textContent).toContain('Unavailable')
    expect(container.querySelector('.settings-about')?.textContent).toContain('0.3.0')
  })
})
