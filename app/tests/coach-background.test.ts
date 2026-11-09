import { act, createElement as h, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../src/renderer/coach/live'
import type { Route } from '../src/renderer/routes'

const live = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('../src/renderer/coach/live', () => ({
  MAX_SESSION_MS: 45 * 60 * 1000,
  LiveSession: class {
    state: SessionView = { status: { kind: 'live' }, turns: [], partial: null, activity: [], elapsedMs: 1000, speaking: false, responding: false, unknown: {} }
    start = vi.fn(async () => {})
    stop = vi.fn(async () => { this.state.status = { kind: 'ended' } })
    abandon = vi.fn()
    view = () => ({ ...this.state })
    constructor() { live.instances.push(this) }
  }
}))
import CoachLauncher, { FLOATING_COACH_BUTTON_CHANGED } from '../src/renderer/coach/CoachLauncher'
import { FloatingNotebooks } from '../src/renderer/writing-notebooks/NotebookLauncher'

let root: Root, container: HTMLDivElement, api: any, shown: boolean
const coach = { id: 'coach-1', name: 'French', sessions: 0, files: 0, model: 'gpt-live-1' }
const navigate = vi.fn()
const flush = async () => act(async () => { await vi.advanceTimersByTimeAsync(180) })
const click = async (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click())
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
function Harness() {
  const [route, setRoute] = useState<Route>({ name: 'library' })
  return h('div', {}, h('button', { id: 'navigate', onClick: () => setRoute({ name: 'documents' }) }, 'Navigate'),
    h(CoachLauncher, { route, userId: 'user', navigate }), h(FloatingNotebooks, { route, userId: 'user' }))
}
beforeEach(() => {
  vi.useFakeTimers(); live.instances.length = 0; shown = true; navigate.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  api = {
    getFloatingCoachButton: vi.fn(async () => shown), getFloatingNotebookButton: vi.fn(async () => true),
    listCoachProjects: vi.fn(async () => [coach]), onCoachChanged: () => () => {},
    startCoachSession: vi.fn(async () => ({ status: 'ok', sessionId: 'session' })), endCoachSession: vi.fn(async () => null),
    createCoachProject: vi.fn(async ({ name, association }) => ({ ...coach, name, association })),
    deleteCoachProject: vi.fn(async () => {}),
    writing: { association: vi.fn(async (association) => ({ ...association, title: 'French course' })), onChanged: () => () => {}, search: vi.fn(async () => []) }
  }
  vi.stubGlobal('opencourse', api)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals() })
const openCoach = async () => { await click('.coach-floating .writing-launcher-toggle'); await click('.coach-floating .writing-launcher-row'); await flush() }

describe('floating coach conversation lifecycle', () => {
  it('replaces the active dot with speech volume on the collapsed launcher and resets it when quiet or stopped', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    await click('.coach-floating header button')
    const launcher = container.querySelector<HTMLElement>('.coach-floating')!
    const level = () => Number(launcher.style.getPropertyValue('--floating-audio-level'))
    expect(launcher.classList.contains('conversation-active')).toBe(true)
    expect(launcher.querySelector('.floating-live-dot')).toBeNull()
    expect(level()).toBe(0)
    live.instances[0].state.speaking = true
    live.instances[0].state.outputLevel = .03
    await flush()
    const quiet = level()
    expect(quiet).toBeGreaterThan(0)
    live.instances[0].state.outputLevel = .1
    await flush()
    expect(level()).toBeGreaterThan(quiet)
    live.instances[0].state.speaking = false
    await flush()
    expect(level()).toBe(0)
    expect(launcher.classList.contains('conversation-active')).toBe(true)
    await click('.coach-floating .writing-launcher-toggle')
    await act(async () => button('End conversation').click())
    expect(launcher.classList.contains('conversation-active')).toBe(false)
    expect(level()).toBe(0)
  })
  it('shows a background failure while keeping the conversation available', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    live.instances[0].state.warning = 'The coach’s background work failed. You can keep talking.'
    await flush()
    expect(container.querySelector('[role=alert]')?.textContent).toContain('background work failed')
    expect(container.textContent).toContain('Listening')
    expect(button('End conversation').disabled).toBe(false)
    live.instances[0].state.warning = undefined
    await flush()
    expect(container.querySelector('[role=alert]')).toBeNull()
  })
  it('confirms deletion in a separate popup and cancels without changing the coach', async () => {
    await act(async () => root.render(h(Harness)))
    await click('.coach-floating .writing-launcher-toggle')
    await click('[aria-label="Manage French"]')
    const options = container.querySelector('.coach-launcher-manage')!
    const original = options.textContent
    await act(async () => { button('Delete').focus(); button('Delete').click() })
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
    expect(dialog.classList.contains('writing-title-dialog')).toBe(true)
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.textContent).toContain('“French” and its memory will be permanently deleted')
    expect(options.textContent).toBe(original)
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(api.deleteCoachProject).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('Delete'))
    await act(async () => button('Delete').click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role=dialog] .secondary')!.click())
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(api.deleteCoachProject).not.toHaveBeenCalled()
  })
  it('keeps deletion errors in the popup and prevents repeat confirmation while deleting', async () => {
    api.deleteCoachProject.mockRejectedValueOnce(new Error('Could not delete coach'))
    await act(async () => root.render(h(Harness)))
    await click('.coach-floating .writing-launcher-toggle')
    await click('[aria-label="Manage French"]')
    await act(async () => button('Delete').click())
    const confirm = document.querySelector<HTMLButtonElement>('[role=dialog] .action-button:not(.secondary)')!
    await act(async () => confirm.click())
    expect(document.querySelector('[role=dialog] [role=alert]')?.textContent).toBe('Could not delete coach')
    expect(container.querySelector('.coach-launcher-row strong')?.textContent).toBe('French')
    let finish!: () => void
    api.deleteCoachProject.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await act(async () => confirm.click())
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Deleting…')
    expect(document.querySelector<HTMLButtonElement>('[role=dialog] .secondary')?.disabled).toBe(true)
    await act(async () => {
      confirm.click()
      confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    expect(api.deleteCoachProject).toHaveBeenCalledTimes(2)
    expect(api.deleteCoachProject).toHaveBeenLastCalledWith(coach.id)
    await act(async () => finish())
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(container.querySelector('.coach-launcher-entry')).toBeNull()
  })
  it('starts once, survives collapse, navigation and notebook opening, and ends from the same panel', async () => {
    await act(async () => root.render(h(Harness)))
    await openCoach()
    expect(api.startCoachSession).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Listening')
    await click('.coach-floating header button')
    expect(container.querySelector('.coach-floating.conversation-active')).not.toBeNull()
    await click('#navigate')
    await click('.notebook-floating .writing-launcher-toggle')
    expect(container.querySelector('.coach-floating.expanded')).toBeNull()
    expect(live.instances[0].abandon).not.toHaveBeenCalled()
    await click('.coach-floating .writing-launcher-toggle')
    expect(container.querySelector('.notebook-floating.expanded')).toBeNull()
    expect(api.startCoachSession).toHaveBeenCalledTimes(1)
    await act(async () => button('End conversation').click())
    expect(live.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.coach-conversation')).toBeNull()
    expect(container.querySelector('.coach-floating .writing-launcher-row')).not.toBeNull()
  })
  it('keeps controls present until disabling finishes memory saving', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    let finish!: () => void
    live.instances[0].stop.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    shown = false
    await act(async () => window.dispatchEvent(new Event(FLOATING_COACH_BUTTON_CHANGED)))
    expect(container.querySelector('.coach-floating')).not.toBeNull()
    expect(container.textContent).toContain('Saving what we worked on')
    await act(async () => finish())
    expect(container.querySelector('.coach-floating')).toBeNull()
    shown = true
    await act(async () => window.dispatchEvent(new Event(FLOATING_COACH_BUTTON_CHANGED)))
    expect(container.querySelector('.coach-floating')).not.toBeNull()
  })
  it('grays out and disables End conversation while saving without allowing a second stop', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    let finish!: () => void
    live.instances[0].stop.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const end = button('End conversation')
    await act(async () => end.click())
    expect(end.disabled).toBe(true)
    expect(end.textContent).toBe('End conversation')
    await act(async () => end.click())
    await flush()
    expect(live.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.coach-conversation')).not.toBeNull()
    await act(async () => finish())
    expect(container.querySelector('.coach-conversation')).toBeNull()
  })
  it('also disables End conversation during automatic wrap-up', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    live.instances[0].state.status = { kind: 'wrapping-up', note: 'Saving notes…' }
    await flush()
    expect(button('End conversation').disabled).toBe(true)
  })
  it('cancels a pending start and releases a late-created main-process session without opening a microphone', async () => {
    let ready!: (value: unknown) => void
    api.startCoachSession.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    await act(async () => root.render(h(Harness)))
    await click('.coach-floating .writing-launcher-toggle'); await click('.coach-floating .writing-launcher-row')
    await act(async () => button('End conversation').click())
    await act(async () => ready({ status: 'ok', sessionId: 'late' }))
    expect(api.endCoachSession).toHaveBeenCalledWith('late', { status: 'ended' })
    expect(live.instances).toHaveLength(0)
    expect(container.querySelector('.coach-conversation')).toBeNull()
  })
  it('cleans up an active session when the shell unmounts', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    await act(async () => root.render(null))
    expect(live.instances[0].abandon).toHaveBeenCalledOnce()
  })
  it('shows missing-key recovery without opening a second screen or losing the coach', async () => {
    api.startCoachSession.mockResolvedValue({ status: 'no-key' })
    await act(async () => root.render(h(Harness))); await openCoach()
    expect(container.textContent).toContain('Add an OpenAI API key')
    expect(live.instances).toHaveLength(0)
    await act(async () => button('Open settings').click())
    expect(navigate).toHaveBeenCalledWith({ name: 'settings', from: { name: 'library' }, section: 'connections' })
  })
  it('creates a coach through the name popup and enters conversation mode', async () => {
    await act(async () => root.render(h(CoachLauncher, { route: { name: 'course', courseId: 'course-1' }, userId: 'user', navigate })))
    await click('.coach-floating .writing-launcher-toggle')
    await act(async () => button('＋ New coach').click())
    const input = document.querySelector<HTMLInputElement>('[role=dialog] input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My French coach'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(api.createCoachProject).toHaveBeenCalledWith({ name: 'My French coach' })
    expect(api.startCoachSession).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.coach-conversation-heading')?.textContent).toContain('My French coach')
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('shows only running tools beside End conversation, counts concurrent calls and hides them when finished', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    const session = live.instances[0]
    session.state.turns = [{ seq: 1, role: 'user', text: 'Bonjour', at: 'now' }]
    session.state.activity = [
      { id: 1, text: 'Searching web “Einstein 1905”', ok: true, state: 'running' },
      { id: 2, text: 'Read context.md', ok: true, state: 'completed' },
      { id: 3, text: 'search failed', ok: false, state: 'failed' },
      ...[4, 5, 6].map(id => ({ id, text: `Reading file ${id}`, ok: true, state: 'running' }))
    ]
    await flush()
    expect(container.querySelector('.coach-conversation-transcript')?.textContent).toContain('Bonjour')
    const footer = container.querySelector('.coach-conversation footer')!
    expect(footer.firstElementChild?.textContent).toBe('End conversation')
    expect(footer.querySelector('.coach-current-tool-label')?.textContent).toBe('Searching web “Einstein 1905”')
    expect(footer.querySelector('.coach-current-tool-count')?.textContent).toBe('+3')
    expect(container.querySelector('.coach-conversation-tools')).toBeNull()
    expect(container.querySelector('.coach-conversation')?.textContent).not.toContain('Read context.md')
    expect(container.querySelector('.coach-conversation')?.textContent).not.toContain('search failed')
    session.state.activity = session.state.activity.map((entry: any) => ({ ...entry, state: entry.id === 6 ? 'running' : 'completed' }))
    await flush()
    expect(footer.querySelector('.coach-current-tool-label')?.textContent).toBe('Reading file 6')
    expect(footer.querySelector('.coach-current-tool-count')).toBeNull()
    session.state.activity = session.state.activity.map((entry: any) => ({ ...entry, state: 'completed' }))
    await flush()
    expect(footer.querySelector('.coach-current-tools')).toBeNull()
    await act(async () => button('End conversation').click())
    expect(container.textContent).not.toContain('search failed')
    expect(container.textContent).toContain('Conversation ended.')
  })
  it('keeps session save warnings after ending without carrying failed tool calls into the coach list', async () => {
    await act(async () => root.render(h(Harness))); await openCoach()
    live.instances[0].state.activity = [
      { id: 1, text: 'search failed', ok: false, state: 'failed' },
      { id: 2, text: 'The coach could not save notes on the way out.', ok: false }
    ]
    await act(async () => button('End conversation').click())
    expect(container.textContent).not.toContain('search failed')
    expect(container.textContent).toContain('The coach could not save notes on the way out.')
  })
})
