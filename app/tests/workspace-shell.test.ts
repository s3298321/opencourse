import { act, createElement as h, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/components/useAppUpdate', () => ({ useAppUpdate: () => null }))
import AppShell, { useAppShell } from '../src/renderer/components/AppShell'
import TitleBar from '../src/renderer/components/TitleBar'
import { ScreenHost, useScreenActive } from '../src/renderer/screen-activity'
import { initialNavigation, navigateWorkspace, switchWorkspace } from '../src/renderer/workspaces'
import type { Route, Screen } from '../src/renderer/routes'
import CodeEditor from '../src/renderer/workbench/CodeEditor'
import type { WorkbenchTheme } from '../src/renderer/workbench/theme'

const theme: WorkbenchTheme = { dark: true, fg: '#eee', bg: '#111', muted: '#aaa', accent: '#ddd', border: '#444', ok: '#0f0', err: '#f00', scrollbar: '#333', scrollbarHover: '#555', activeLine: '#111', selection: '#333', mono: 'monospace' }
const handled = vi.fn()
function Fixture({ screen, navigate }: { screen: Screen; navigate: (route: Route) => void }) {
  const active = useScreenActive()
  const shell = useAppShell()
  useEffect(() => {
    if (!active) return
    const handler = (): void => handled(screen.name)
    document.addEventListener('test-shortcut', handler)
    return () => document.removeEventListener('test-shortcut', handler)
  }, [active, screen.name])
  useEffect(() => {
    if (screen.name === 'coach') shell?.reportCoachLive(true)
    return () => { if (screen.name === 'coach') shell?.reportCoachLive(false) }
  }, [shell, screen.name])
  return h('div', { className: 'body' },
    h(TitleBar, { route: screen, navigate, back: { label: screen.name, onClick: () => navigate({ name: 'library' }) },
      actions: h('button', { className: 'fixture-settings', onClick: () => navigate({ name: 'settings', from: screen }) }, 'Settings') }),
    screen.name === 'library' ? h(CodeEditor, { docKey: 'exercise', language: 'python', indentUnit: '    ', initialDoc: 'print(1)', theme, onChange: () => {}, onSave: () => {}, onRun: () => {} }) : h('input', { className: screen.name === 'documents' ? 'document-draft' : 'coach-draft', defaultValue: '' }))
}
function Harness() {
  const [state, setState] = useState(() => navigateWorkspace(initialNavigation(), { name: 'library' }))
  const navigate = (route: Route): void => setState(value => navigateWorkspace(value, route))
  const overlay = state.route.name === 'settings'
  return h(AppShell, { route: state.route, user: null, navigate, switchWorkspace: section => setState(value => switchWorkspace(value, section)) },
    ...(['courses', 'documents', 'coach'] as const).map(section => state[section] && h(ScreenHost, { key: section, active: !overlay && state.route === state[section] }, h(Fixture, { screen: state[section]!, navigate }))),
    overlay && h(ScreenHost, { active: true }, h(TitleBar, { route: state.route, navigate, back: { label: 'Back', onClick: () => navigate(state.route.name === 'settings' ? state.route.from : state.route) } }), h('div', { className: 'settings' }, 'Overlay')))
}
let root: Root, container: HTMLDivElement
const rangeGeometry = ['getClientRects', 'getBoundingClientRect'] as const
const originalGeometry = rangeGeometry.map(name => Object.getOwnPropertyDescriptor(Range.prototype, name))
beforeEach(() => {
  handled.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // JSDOM has no text geometry; CodeMirror measures it on an animation frame.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals()
  rangeGeometry.forEach((name, index) => { const original = originalGeometry[index]; if (original) Object.defineProperty(Range.prototype, name, original); else Reflect.deleteProperty(Range.prototype, name) })
})
const click = async (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click())
describe('persistent shell', () => {
  it('restores a reading position at zero even when background output moves the parked pane', async () => {
    const pane = (active: boolean) => h(ScreenHost, { active }, h('div', { className: 'scroll' }, h('input')))
    await act(async () => root.render(pane(true)))
    const scroller = container.querySelector<HTMLElement>('.scroll')!, input = container.querySelector<HTMLInputElement>('input')!
    Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } })
    await act(async () => input.focus())
    await act(async () => root.render(pane(false)))
    scroller.scrollTop = 400
    await act(async () => root.render(pane(true)))
    expect(scroller.scrollTop).toBe(0)
    expect(document.activeElement).toBe(input)
  })
  it('keeps chrome, editor selection and undo history through both section switches', async () => {
    await act(async () => root.render(h(Harness)))
    const chrome = container.querySelector('.titlebar'), thumb = container.querySelector('.section-switch-thumb')
    const editorElement = container.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editorElement)!
    await act(async () => view.dispatch({ changes: { from: 6, to: 7, insert: '2' }, selection: { anchor: 7 } }))
    await click('[data-section="coach"]')
    expect(container.querySelectorAll('.titlebar')).toHaveLength(1)
    expect(container.querySelector('.titlebar')).toBe(chrome)
    expect(container.querySelector('.section-switch-thumb')).toBe(thumb)
    const liveIndicator = container.querySelector('[data-section="coach"] .coach-live-indicator')
    expect(liveIndicator).not.toBeNull()
    await act(async () => document.dispatchEvent(new Event('test-shortcut')))
    expect(handled).toHaveBeenLastCalledWith('coach')
    expect(handled).toHaveBeenCalledOnce()
    const coach = container.querySelector<HTMLInputElement>('.coach-draft')!
    coach.value = 'unfinished instructions'
    await click('[data-section="documents"]')
    expect(container.querySelector('.titlebar')).toBe(chrome)
    const documentDraft = container.querySelector<HTMLInputElement>('.document-draft')!
    documentDraft.value = 'A document question'
    await click('[data-section="courses"]')
    expect(EditorView.findFromDOM(editorElement)).toBe(view)
    expect(view.state.doc.toString()).toBe('print(2)')
    expect(view.state.selection.main.anchor).toBe(7)
    await act(async () => undo(view))
    expect(view.state.doc.toString()).toBe('print(1)')
    expect(container.querySelector('.coach-live-indicator')).toBe(liveIndicator)
    await click('[data-section="coach"]')
    expect(container.querySelector('.coach-live-indicator')).toBe(liveIndicator)
    expect(container.querySelector('.coach-draft')).toBe(coach)
    expect(coach.value).toBe('unfinished instructions')
    await click('[data-section="documents"]')
    expect(container.querySelector('.document-draft')).toBe(documentDraft)
    expect(documentDraft.value).toBe('A document question')
  })
  it('allows only the overlay declaration to own the bar and dismisses it on a section switch', async () => {
    await act(async () => root.render(h(Harness)))
    await click('.fixture-settings')
    expect(container.querySelector('.titlebar .crumbs')?.textContent).toContain('Back')
    expect(container.querySelector('.fixture-settings')).toBeNull()
    await act(async () => document.dispatchEvent(new Event('test-shortcut')))
    expect(handled).not.toHaveBeenCalled()
    await click('[data-section="courses"]')
    expect(container.querySelector('.settings')).toBeNull()
    expect(container.querySelector('.fixture-settings')).not.toBeNull()
  })
})
