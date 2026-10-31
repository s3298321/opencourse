import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Menu from '../src/renderer/components/Menu'
import { ScreenHost } from '../src/renderer/screen-activity'

let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Element.prototype.getAnimations = () => []
  root = createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('ignores scroll events from parked panes but dismisses when the visible screen scrolls', async () => {
  await act(async () => root.render(h('div', null,
    h(Menu, { label: 'Settings', items: [{ id: 'settings', label: 'Settings', onSelect: () => {} }] }),
    h(ScreenHost, { active: false }, h('div', { className: 'parked-output' })),
    h(ScreenHost, { active: true }, h('div', { className: 'visible-content' }, h('textarea'))))))
  await act(async () => document.querySelector<HTMLButtonElement>('.menu-trigger')!.click())
  expect(document.querySelector('.menu-panel')).not.toBeNull()
  await act(async () => document.querySelector('.parked-output')!.dispatchEvent(new Event('scroll')))
  expect(document.querySelector('.menu-panel')).not.toBeNull()
  await act(async () => document.querySelector('textarea')!.dispatchEvent(new Event('scroll')))
  expect(document.querySelector('.menu-panel')).not.toBeNull()
  await act(async () => document.querySelector('.visible-content')!.dispatchEvent(new Event('scroll')))
  expect(document.querySelector('.menu-panel')).toBeNull()
})
it('keeps normal page clicks and supports keyboard context-menu dismissal and disabled actions', async () => {
  const select = vi.fn(), remove = vi.fn()
  await act(async () => root.render(h(Menu, { label: 'Page', triggerMode: 'contextmenu', onClick: select, items: [{ id: 'delete', label: 'Delete page', disabled: true, onSelect: remove }] })))
  const trigger = document.querySelector<HTMLButtonElement>('.menu-trigger')!
  await act(async () => trigger.click())
  expect(select).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })) })
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(document.activeElement).toBe(menu)
  await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(remove).not.toHaveBeenCalled()
  await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
