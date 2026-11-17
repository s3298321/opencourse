import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_NOTEBOOK_BUTTON_CHANGED, FloatingNotebooks } from '../src/renderer/writing-notebooks/NotebookLauncher'
import type { Route } from '../src/renderer/routes'
import type { NotebookAssociation } from '../src/core/writing-notebooks/types'

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
  it.each([
    { route: { name: 'course', courseId: 'source' }, kind: 'course', existing: [], expected: 'étude-of-linear-algebra-1' },
    { route: { name: 'document', documentId: 'source' }, kind: 'document', existing: ['Étude-of-linear-algebra-1', 'étude-of-linear-algebra-2'], expected: 'étude-of-linear-algebra-3' },
  ] as const)('suggests an editable title for a $kind notebook', async ({ route, kind, existing, expected }) => {
    const source: NotebookAssociation = { kind, id: 'source', title: 'Étude of Linear Algebra: Part Two' }
    const create = vi.fn(async () => ({ id: 'created' }))
    Object.assign(window.opencourse.writing, {
      association: async () => source, list: async () => existing.map(title => ({ title })), create, open: vi.fn(), pickFolder: vi.fn(async () => null),
    })
    await act(async () => { root.render(h(FloatingNotebooks, { route, userId: 'user' })) })
    await act(async () => container.querySelector<HTMLButtonElement>('.writing-launcher-toggle')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.writing-create[title]')!.click())
    const input = document.querySelector<HTMLInputElement>('[aria-label="Notebook title"]')!
    expect(input.value).toBe(expected)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My reading notes')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.form!.requestSubmit())
    expect(create).toHaveBeenCalledWith('My reading notes', source, null)
  })
  it('offers an optional folder and passes the chosen path to create', async () => {
    const source: NotebookAssociation = { kind: 'course', id: 'source', title: 'Étude of Linear Algebra: Part Two' }
    const create = vi.fn(async () => ({ id: 'created' }))
    const pickFolder = vi.fn(async () => '/Users/example/Notes')
    Object.assign(window.opencourse.writing, {
      association: async () => source, list: async () => [], create, open: vi.fn(), pickFolder,
    })
    await act(async () => { root.render(h(FloatingNotebooks, { route: { name: 'course', courseId: 'source' } as Route, userId: 'user' })) })
    await act(async () => container.querySelector<HTMLButtonElement>('.writing-launcher-toggle')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.writing-create[title]')!.click())
    const choose = () => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Choose'))
    expect(document.querySelector('.writing-folder-label')?.textContent).toBe('Choose custom folder (optional):')
    await act(async () => choose()!.click())
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.writing-folder-path-text')?.textContent).toBe('/Users/example/Notes')
    expect(choose()).toBeUndefined()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Use the default location"]')!.click())
    expect(document.querySelector('.writing-folder-path')).toBeNull()
    await act(async () => choose()!.click())
    const input = document.querySelector<HTMLInputElement>('[aria-label="Notebook title"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Folder notes')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.form!.requestSubmit())
    expect(create).toHaveBeenCalledWith('Folder notes', source, '/Users/example/Notes')
  })
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
