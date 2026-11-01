import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { selectedContent, useCoachContextBridge, useCoachContextProvider } from '../src/renderer/coach/context'
import type { CoachContextRequest } from '../src/core/coach/context'

let container: HTMLDivElement, root: Root, handler: (request: CoachContextRequest) => void
const reply = vi.fn(), off = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  window.opencourse = { onCoachContextRequest: (callback: (request: CoachContextRequest) => void) => { handler = callback; return off }, replyCoachContext: reply } as unknown as typeof window.opencourse
  reply.mockClear(); off.mockClear()
  container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
function select(node: Node, start: number, end: number) {
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
}
it('reads keyboard/browser selections with page attribution and clears them without retaining stale quotes', () => {
  container.innerHTML = '<section data-page="7"><span>Selected PDF passage</span></section><aside>Chat answer</aside>'
  const page = container.querySelector('section')!
  select(page.firstChild!.firstChild!, 0, 12)
  expect(selectedContent(page)).toMatchObject({ selectedText: 'Selected PDF', selectionPage: 7 })
  window.getSelection()?.removeAllRanges()
  expect(selectedContent(page).selectedText).toBe('')
  select(container.querySelector('aside')!.firstChild!, 0, 4)
  expect(selectedContent(page).selectedText).toBe('')
  page.setAttribute('hidden', '')
  select(page.firstChild!.firstChild!, 0, 12)
  expect(selectedContent(page).selectedText).toBe('')
})
it('reads long CodeMirror selections from editor state, excludes other panes and respects deselection', () => {
  container.innerHTML = '<section data-cell-id="cell-2"></section><aside>Another answer</aside>'
  const host = container.querySelector('section')!
  const editor = new EditorView({ parent: host, state: EditorState.create({ doc: 'x'.repeat(6000), selection: { anchor: 100, head: 5100 } }) })
  try {
    expect(selectedContent(host)).toMatchObject({ selectedText: 'x'.repeat(2400), selectionTruncated: true, cellId: 'cell-2' })
    select(container.querySelector('aside')!.firstChild!, 0, 7)
    expect(selectedContent(host).selectedText).toBe('')
    window.getSelection()?.removeAllRanges()
    editor.dispatch({ selection: { anchor: 100 } })
    expect(selectedContent(host).selectedText).toBe('')
  } finally { editor.destroy() }
})
it('attributes a blurred editor selection to the right Python cell', () => {
  container.innerHTML = '<section data-cell-id="old"></section><section data-cell-id="current"></section>'
  const hosts = container.querySelectorAll('section')
  const old = new EditorView({ parent: hosts[0]!, state: EditorState.create({ doc: 'Old selected code', selection: { anchor: 0, head: 3 } }) })
  const current = new EditorView({ parent: hosts[1]!, state: EditorState.create({ doc: 'Current selected code', selection: { anchor: 0, head: 7 } }) })
  try {
    select(current.contentDOM.querySelector('.cm-line')!.firstChild!, 0, 7)
    expect(selectedContent(container)).toMatchObject({ selectedText: 'Current', cellId: 'current' })
  } finally { old.destroy(); current.destroy() }
})
it('answers on demand from the latest render, isolates users and unregisters providers', async () => {
  function Harness({ page, user }: { page: number; user: string }) {
    useCoachContextBridge(user)
    useCoachContextProvider(request => request.tool === 'get_app_context' ? { kind: 'document', visible: true, page } : null)
    return null
  }
  const request: CoachContextRequest = { requestId: 'r1', userId: 'one', tool: 'get_app_context', args: {} }
  await act(async () => root.render(h(Harness, { page: 2, user: 'one' })))
  expect(reply).not.toHaveBeenCalled()
  handler(request)
  expect(reply).toHaveBeenLastCalledWith('r1', { entries: [{ kind: 'document', visible: true, page: 2 }] })
  await act(async () => root.render(h(Harness, { page: 9, user: 'one' })))
  handler({ ...request, requestId: 'r2' })
  expect(reply).toHaveBeenLastCalledWith('r2', { entries: [{ kind: 'document', visible: true, page: 9 }] })
  await act(async () => root.render(h(Harness, { page: 5, user: 'two' })))
  handler(request)
  expect(reply.mock.lastCall?.[1]).toHaveProperty('error')
  await act(async () => root.render(null))
  expect(off).toHaveBeenCalled()
  handler({ ...request, userId: 'two' })
  expect(reply).toHaveBeenLastCalledWith('r1', { entries: [] })
})
