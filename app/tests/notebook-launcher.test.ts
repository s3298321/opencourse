import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_NOTEBOOK_BUTTON_CHANGED, FloatingNotebooks } from '../src/renderer/writing-notebooks/NotebookLauncher'
import type { Route } from '../src/renderer/routes'

const route = { name: 'library' } as Route
let shown = true
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  shown = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('opencourse', {
    getFloatingNotebookButton: vi.fn(async () => shown),
    writing: { association: vi.fn(async () => undefined), onChanged: () => () => {}, search: vi.fn(async () => []) }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('floating notebooks button', () => {
  it('stays visible until Settings turns it off, then comes back when turned on', async () => {
    await act(async () => { root.render(h(FloatingNotebooks, { route, userId: 'user' })) })
    await act(async () => {})
    expect(container.querySelector('.writing-launcher-toggle')).not.toBeNull()
    shown = false
    await act(async () => { window.dispatchEvent(new Event(FLOATING_NOTEBOOK_BUTTON_CHANGED)) })
    expect(container.querySelector('.writing-launcher')).toBeNull()
    shown = true
    await act(async () => { window.dispatchEvent(new Event(FLOATING_NOTEBOOK_BUTTON_CHANGED)) })
    expect(container.querySelector('.writing-launcher-toggle')).not.toBeNull()
  })
})
