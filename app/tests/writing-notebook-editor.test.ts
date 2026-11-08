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

const shortcut = (editor: EditorView, key = 'e') => editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
  key, code: 'Key' + key.toUpperCase(), ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true
}))
it.each([
  ['', 0, ['SKETCH']],
  ['Before\n  \nAfter', 8, ['Before', 'SKETCH', 'After']],
  ['Before\nAfter', 3, ['Before', 'SKETCH', 'After']],
  ['Last line', 4, ['Last line', 'SKETCH']]
])('inserts one editable sketch at the caret in %j', async (initial, anchor, expected) => {
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial: String(initial), showLineNumbers: true })))
  const editor = view()
  await act(async () => { editor.dispatch({ selection: { anchor: Number(anchor) } }); shortcut(editor) })
  const source = editor.state.doc.toString(), sketch = /!\[Sketch\]\(assets\/[\da-f-]+\.sketch\.svg\)/.exec(source)![0]
  expect(source.replace(sketch, 'SKETCH').split('\n')).toEqual(expected)
  expect(container.querySelector('.sketch-canvas')).toBe(document.activeElement)
  expect(container.querySelector('.cm-content')?.textContent).not.toContain('assets/')
  await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  expect(container.querySelector('.sketch-preview img')).toBeTruthy()
  await act(async () => { container.querySelector<HTMLButtonElement>('.sketch-preview')!.click() })
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.activeElement).toBe(editor.contentDOM)
  expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(editor.state.doc.lineAt(source.indexOf(sketch)).number + 1)
  const from = source.indexOf(sketch)
  await act(async () => editor.dispatch({ selection: { anchor: from, head: from + sketch.length } }))
  expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe(sketch)
  await act(async () => editor.dispatch(editor.state.replaceSelection('')))
  expect(container.querySelector('.writing-sketch')).toBeNull()
})
it('keeps fenced sketch examples literal and missing assets selectable', async () => {
  const link = `![Sketch](assets/${crypto.randomUUID()}.sketch.svg)`
  vi.stubGlobal('opencourse', { writing: { readSketch: async () => { throw new Error('Missing') } } })
  const initial = ['```', link, '```', '', link].join('\n')
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial })))
  expect(container.querySelectorAll('.writing-sketch')).toHaveLength(1)
  expect(container.querySelector('.sketch-error')?.textContent).toContain('could not be opened')
  expect(container.querySelector('.writing-code-line')?.parentElement?.textContent).toContain(link)
  expect(view().state.doc.toString()).toBe(initial)
})

it('draws, erases, resizes and undoes individual gestures, with independent copies and retryable writes', async () => {
  const save = vi.fn().mockResolvedValue(undefined), ref = createRef<MarkdownEditorHandle>()
  vi.stubGlobal('opencourse', { writing: { saveSketch: save } })
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial: '', ref })))
  const editor = view()
  await act(async () => { shortcut(editor) })
  const frame = () => container.querySelector<HTMLElement>('.sketch-canvas')!
  const surface = () => container.querySelector<SVGSVGElement>('.sketch-drawing')!
  const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  const gesture = async (target: Element, x: number, y: number, dx: number, dy: number) => {
    Object.defineProperty(target, 'setPointerCapture', { configurable: true, value: () => {} })
    vi.spyOn(frame(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 225, 150))
    await act(async () => { target.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y, button: 0, bubbles: true })) })
    await act(async () => { target.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x + dx, clientY: y + dy, bubbles: true })) })
  }
  const thickness = container.querySelector<HTMLSelectElement>('[aria-label="Brush thickness"]')!
  await act(async () => { thickness.value = '8'; thickness.dispatchEvent(new Event('change', { bubbles: true })) })
  for (const tool of ['Brush', 'Rectangle', 'Circle', 'Arrow']) {
    await click(tool)
    await gesture(surface(), 25, 50, 35, 20)
  }
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(4)
  const original = editor.state.doc.toString()
  await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('.sketch-preview')!.click())
  await click('Undo sketch edit')
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(3)
  await click('Redo sketch edit')
  expect(editor.state.doc.toString()).toBe(original)
  await ref.current!.flushSketches(original)
  expect(save).toHaveBeenCalledTimes(1)
  const model = save.mock.calls[0][2]
  expect(model.marks.map((m: { width: number }) => m.width)).toEqual([8, 8, 8, 8])
  expect(model.marks[0].points).toEqual([[50, 100], [120, 140]])
  await click('Eraser')
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Brush thickness"]')!
    select.value = '8'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  Object.defineProperty(surface(), 'setPointerCapture', { configurable: true, value: () => {} })
  vi.spyOn(frame(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 225, 150))
  const eraseEvent = (type: string, x: number, y: number) => act(async () => {
    surface().dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }))
  })
  await eraseEvent('pointerdown', 10, 50)
  await eraseEvent('pointermove', 30, 50)
  expect(editor.state.doc.toString()).toBe(original)
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(4)
  const trace = surface().querySelector('.sketch-eraser-trace')!
  expect(trace.getAttribute('opacity')).toBe('0.4')
  expect(trace.firstElementChild?.getAttribute('stroke-width')).toBe('8')
  await eraseEvent('pointercancel', 0, 0)
  expect(surface().querySelector('.sketch-eraser-trace')).toBeNull()
  expect(editor.state.doc.toString()).toBe(original)
  await gesture(surface(), 10, 50, 20, 0)
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(0)
  expect(surface().querySelector('.sketch-eraser-trace')).toBeNull()
  await click('Undo sketch edit')
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(4)
  await click('Redo sketch edit')
  expect(surface().querySelectorAll('[data-mark]')).toHaveLength(0)
  await click('Undo sketch edit')
  await gesture(container.querySelector('.sketch-resize')!, 225, 150, -165, -80)
  expect(surface().getAttribute('viewBox')).toBe('0 0 120 140')
  await click('Undo sketch edit')
  expect(surface().getAttribute('viewBox')).toBe('0 0 450 300')
  expect(editor.state.doc.toString()).toBe(original)
  await act(async () => { frame().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await act(async () => editor.dispatch({ changes: { from: editor.state.doc.length, insert: original } }))
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.sketch-preview')[1]!.click())
  await gesture(surface(), 60, 60, 5, 10)
  expect(editor.state.doc.line(1).text).toBe(original)
  expect(editor.state.doc.line(2).text).not.toBe(original)
  save.mockRejectedValueOnce(new Error('Disk full'))
  await expect(ref.current!.flushSketches(editor.state.doc.toString())).rejects.toThrow('Disk full')
  await ref.current!.flushSketches(editor.state.doc.toString())
  expect(save.mock.calls.at(-1)?.[2].marks).toHaveLength(5)
  expect(save.mock.calls.at(-1)?.[1]).toBe(save.mock.calls.at(-2)?.[1])
})

it('keeps rapid brush strokes when pointer events outrun the widget render or capture ends early', async () => {
  const save = vi.fn().mockResolvedValue(undefined), ref = createRef<MarkdownEditorHandle>()
  vi.stubGlobal('opencourse', { writing: { saveSketch: save } })
  await act(async () => root.render(h(MarkdownEditor, { ...props, initial: '', ref })))
  await act(async () => { shortcut(view()) })
  const surface = container.querySelector<SVGSVGElement>('.sketch-drawing')!
  Object.defineProperty(surface, 'setPointerCapture', { value: () => {} })
  vi.spyOn(surface.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 450, 300))
  const send = (type: string, x: number, id = 1) => surface.dispatchEvent(new PointerEvent(type, {
    pointerId: id, button: 0, clientX: x, clientY: 80, bubbles: true
  }))
  await act(async () => {
    send('pointerdown', 10); send('pointerup', 70)
    send('pointerdown', 20); send('pointerup', 80)
    send('pointerdown', 30); send('pointermove', 90)
    send('lostpointercapture', 0, 2)
    send('pointerup', 100)
    send('pointerdown', 40); send('pointermove', 110)
    send('lostpointercapture', 0)
    send('pointerup', 120)
    send('pointerdown', 50)
    const move = new PointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY: 80, bubbles: true })
    Object.defineProperty(move, 'getCoalescedEvents', { value: () => [new PointerEvent('pointermove', { clientX: 130, clientY: 80 })] })
    surface.dispatchEvent(move)
    send('pointercancel', 0); send('lostpointercapture', 0)
  })
  expect(surface.querySelectorAll('[data-mark]')).toHaveLength(5)
  const markdown = view().state.doc.toString()
  await ref.current!.flushSketches(markdown)
  expect(save.mock.calls[0][2].marks.map((m: { points: number[][] }) => m.points.map(p => p[0])))
    .toEqual([[10, 70], [20, 80], [30, 90, 100], [40, 110], [50, 130, 50]])
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Undo sketch edit"]')!.click())
  expect(surface.querySelectorAll('[data-mark]')).toHaveLength(4)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Redo sketch edit"]')!.click())
  expect(view().state.doc.toString()).toBe(markdown)
})
