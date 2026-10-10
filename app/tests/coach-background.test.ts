import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachProject } from '@core/types'
const live = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), abandon: vi.fn(), status: 'idle' }))
vi.mock('../src/renderer/coach/realtime', () => ({
  MAX_SESSION_MS: 2_700_000,
  RealtimeSession: class {
    async start() { live.start(); live.status = 'live' }
    async stop() { live.stop(); live.status = 'ended' }
    abandon() { live.abandon() }
    view() { return { status: { kind: live.status }, turns: [], partial: null, activity: [], elapsedMs: 1000, speaking: false, responding: false, unknown: {} } }
  }
}))
vi.mock('../src/renderer/components/useAppUpdate', () => ({ useAppUpdate: () => null }))
import AppShell from '../src/renderer/components/AppShell'
import CoachSession from '../src/renderer/components/CoachSession'
import { ScreenHost } from '../src/renderer/screen-activity'

const project = { id: 'coach', name: 'Practice' } as CoachProject
let root: Root, container: HTMLDivElement
beforeEach(() => {
  live.status = 'idle'; live.start.mockClear(); live.stop.mockClear(); live.abandon.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('opencourse', { startCoachSession: vi.fn(async () => ({ status: 'ready' })) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
describe('background Coach lifecycle', () => {
  it('keeps the same live connection and pill indicator in both workspaces, and cleans up on exit', async () => {
    const change = vi.fn(), switchWorkspace = vi.fn()
    const render = async (active: boolean) => act(async () => root.render(h(AppShell, { route: active ? { name: 'coachProject', projectId: project.id } : { name: 'library' }, user: null, navigate: vi.fn(), switchWorkspace },
      h(ScreenHost, { active }, h(CoachSession, { project, onSessionChanged: change })))))
    await render(true)
    expect(container.querySelector('.coach-live-indicator')).toBeNull()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Start'))!.click())
    expect(live.start).toHaveBeenCalledOnce()
    const indicator = container.querySelector('.section-switch [data-section="coach"] .coach-live-indicator')
    expect(indicator).not.toBeNull()
    expect(container.querySelector('[data-section="coach"]')?.getAttribute('aria-label')).toBe('Coach (live)')
    await render(false)
    expect(live.abandon).not.toHaveBeenCalled()
    expect(live.stop).not.toHaveBeenCalled()
    expect(container.querySelector('.coach-live-indicator')).toBe(indicator)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-section="coach"]')!.click())
    expect(switchWorkspace).toHaveBeenCalledWith('coach')
    await render(true)
    expect(container.querySelector('.coach-live-indicator')).toBe(indicator)
    expect(live.start).toHaveBeenCalledOnce()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Finish session'))!.click())
    await render(false)
    expect(container.querySelector('.coach-live-indicator')).toBeNull()
    expect(live.stop).toHaveBeenCalledOnce()
  })
  it('abandons the live session when its workspace is actually removed', async () => {
    await act(async () => root.render(h(CoachSession, { project, onSessionChanged: vi.fn() })))
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Start'))!.click())
    await act(async () => root.render(null))
    expect(live.abandon).toHaveBeenCalledOnce()
  })
})
