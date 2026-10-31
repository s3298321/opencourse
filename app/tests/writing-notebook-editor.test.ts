import { act, createElement as h, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MarkdownEditor, { type MarkdownEditorHandle } from '../src/renderer/writing-notebooks/MarkdownEditor'
import type { AskOffer } from '../src/renderer/ask-context'
let root: Root, container: HTMLDivElement
const change = vi.fn(), error = vi.fn(), offer = vi.fn()
const props = { notebookId: 'notebook', initial: '# Heading\n\nA **bold** thought\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nTail', onChange: change, onOffer: offer, onError: error, onSave: () => {} }
const view = () => EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // JSDOM has no text geometry; layout is checked in the browser instead.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({ left: 40, right: 100, top: 100, bottom: 120 })
  change.mockReset(); error.mockReset(); offer.mockReset()
  container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('formats Markdown without changing its source or remounting on a parent render', async () => {
  await act(async () => root.render(h(MarkdownEditor, props)))
  const editor = view()
  await act(async () => editor.dispatch({ selection: { anchor: editor.state.doc.length } }))
  expect(container.querySelector('.writing-bold')?.textContent).toBe('bold')
  expect(container.querySelector('.writing-preview table')?.textContent).toContain('A')
  expect(editor.state.doc.toString()).toBe(props.initial)
  await act(async () => root.render(h(MarkdownEditor, { ...props, onError: () => {} })))
  expect(view()).toBe(editor)
  expect(change).not.toHaveBeenCalled()
})
it('toggles line numbers and layout without recreating the editor or losing edits and undo', async () => {
  await act(async () => root.render(h(MarkdownEditor, props)))
  const editor = view()
  expect(container.querySelector('.cm-lineNumbers')).toBeNull()
  expect(container.querySelector('.writing-editor')?.getAttribute('data-layout')).toBe('wide')
  await act(async () => editor.dispatch({ changes: { from: 0, insert: 'New text\n' }, selection: { anchor: 4 } }))
  await act(async () => root.render(h(MarkdownEditor, { ...props, showLineNumbers: true, textLayout: 'thin' })))
  expect(view()).toBe(editor)
  expect(container.querySelector('.cm-lineNumbers')).not.toBeNull()
  expect(editor.state.selection.main.head).toBe(4)
  expect(editor.state.doc.toString()).toBe(`New text\n${props.initial}`)
  expect(container.querySelector('.writing-editor')?.getAttribute('data-layout')).toBe('thin')
  await act(async () => { undo(editor) })
  expect(editor.state.doc.toString()).toBe(props.initial)
  await act(async () => root.render(h(MarkdownEditor, { ...props, showLineNumbers: false })))
  expect(container.querySelector('.cm-lineNumbers')).toBeNull()
  expect(view()).toBe(editor)
})
it('updates heading number typography and numbering as Markdown changes', async () => {
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial: '# Heading\n\nText', showLineNumbers: true })))
  const editor = view()
  expect(container.querySelector('.cm-lineNumbers .writing-h1 .writing-heading-line-number')?.textContent).toBe('1')
  await act(async () => editor.dispatch({ changes: { from: 0, to: 2, insert: '' } }))
  expect(container.querySelector('.writing-heading-line-number')).toBeNull()
  await act(async () => { undo(editor) })
  expect(container.querySelector('.cm-lineNumbers .writing-h1 .writing-heading-line-number')?.textContent).toBe('1')
  await act(async () => editor.dispatch({ changes: { from: 0, insert: 'Intro\n' } }))
  expect(container.querySelector('.cm-lineNumbers .writing-h1 .writing-heading-line-number')?.textContent).toBe('2')
})
it('clears the quoted selection without highlights and preserves the quote text and undo history', async () => {
  const ref = createRef<MarkdownEditorHandle>()
  await act(async () => root.render(h(MarkdownEditor, { ...props, ref })))
  const editor = view(), from = props.initial.indexOf('thought'), to = from + 7
  await act(async () => { editor.focus(); editor.dispatch({ selection: { anchor: from, head: to } }) })
  const selection = offer.mock.calls.map(call => call[0] as AskOffer | null).filter(Boolean).at(-1)!
  expect(selection.text).toBe('thought')
  await act(async () => { selection.mark(); ref.current!.clearSelection() })
  editor.contentDOM.blur()
  expect(editor.state.selection.main.empty).toBe(true)
  expect(window.getSelection()?.toString()).toBe('')
  expect(container.querySelector('.writing-attached-quote')).toBeNull()
  expect(selection.text).toBe('thought')
  await act(async () => editor.dispatch({ changes: { from: 0, insert: 'Preface\n' }, userEvent: 'input.type' }))
  await act(async () => { undo(editor) })
  expect(editor.state.doc.toString()).toBe(props.initial)
  await act(async () => { redo(editor) })
  expect(editor.state.doc.toString()).toBe(`Preface\n${props.initial}`)
  await act(async () => selection.unmark())
  expect(container.querySelector('.writing-attached-quote')).toBeNull()
})
it('keeps raw HTML inert in preview widgets', async () => {
  const initial = '| X |\n|---|\n| <img src=x onerror=alert(1)> |\n\nTail'
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial })))
  await act(async () => view().dispatch({ selection: { anchor: initial.length } }))
  expect(container.querySelector('.writing-preview img')).toBeNull()
  expect(view().state.doc.toString()).toBe(initial)
})
it.each([1, 2, 3, 4, 5, 6])('aligns level %i heading text without changing its Markdown', async level => {
  const heading = `${'#'.repeat(level)}${level % 2 ? '   ' : '\t'}Heading`, initial = `${heading}\n\nBody`
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial })))
  const editor = view()
  await act(async () => editor.dispatch({ selection: { anchor: initial.length } }))
  expect(container.querySelector('.writing-heading')?.textContent).toBe('Heading')
  await act(async () => editor.dispatch({ selection: { anchor: heading.length } }))
  expect(container.querySelector('.writing-heading')?.textContent).toBe(heading)
  expect(editor.state.doc.toString()).toBe(initial)
  expect(change).not.toHaveBeenCalled()
})
