import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotebookDocument } from '../src/renderer/notebook/useNotebookDocument'
import LessonPythonCell from '../src/renderer/notebook/PythonCell'
import CodeEditor from '../src/renderer/workbench/CodeEditor'
import { AskProvider, type AskOffer } from '../src/renderer/ask-context'
import type { NotebookDocument, NotebookEvent, CellExecution } from '../src/core/notebook/types'
const theme = { dark: true, fg: '#eee', bg: '#111', muted: '#aaa', accent: '#ddd', border: '#444', ok: '#0f0', err: '#f00', scrollbar: '#333', scrollbarHover: '#555', activeLine: '#111', selection: '#333', mono: 'monospace' }
vi.mock('../src/renderer/workbench/theme', async original => ({ ...(await original<typeof import('../src/renderer/workbench/theme')>()), useWorkbenchTheme: () => theme }))
let root: Root, container: HTMLDivElement
let saved: NotebookDocument, events: Set<(event: NotebookEvent) => void>
let hook: ReturnType<typeof useNotebookDocument>
const run = vi.fn(), stop = vi.fn(), save = vi.fn()
function Harness() { hook = useNotebookDocument('course'); return h('div', null, hook.error) }
const emit = async (event: NotebookEvent) => act(async () => { for (const receive of events) receive(event) })
const codeView = () => EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  events = new Set(); saved = { version: 1, revision: 0, cells: [{ id: crypto.randomUUID(), content: 'original' }] }
  save.mockReset().mockImplementation(async (_course, revision, cells) => {
    if (saved.revision !== revision) return { ok: false, document: structuredClone(saved) }
    saved = { version: 1, revision: revision + 1, cells }; return { ok: true, document: structuredClone(saved) }
  })
  run.mockReset(); stop.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('opencourse', {
    getNotebook: vi.fn(async () => structuredClone(saved)), saveNotebook: save,
    onNotebookEvent: (fn: (event: NotebookEvent) => void) => { events.add(fn); return () => events.delete(fn) },
    getNotebookStatus: vi.fn(async () => ({ enabled: true, stage: 'ready', kernel: 'stopped' })), onCoursesChanged: () => () => {},
    runPythonCell: run, stopLessonCell: stop
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
describe('notebook autosave', () => {
  it('saves source and structural edits and tolerates output-only revision advances', async () => {
    await act(async () => root.render(h(Harness)))
    await act(async () => { hook.change([{ ...hook.cells![0]!, content: 'local' }]); saved.revision++; await hook.flush() })
    expect(saved.cells[0]!.content).toBe('local'); expect(hook.dirty).toBe(false)
    await act(async () => { hook.change([]); await hook.flush() })
    expect(saved.cells).toEqual([])
  })
  it('keeps local edits on remote conflicts, then supports reload or explicit overwrite', async () => {
    await act(async () => root.render(h(Harness)))
    await act(async () => hook.change([{ ...hook.cells![0]!, content: 'local' }]))
    saved = { ...saved, revision: 2, cells: [{ ...saved.cells[0]!, content: 'another window' }] }
    await emit({ type: 'document', courseId: 'course', document: structuredClone(saved) })
    expect(hook.conflict).toBe(true); expect(hook.cells![0]!.content).toBe('local')
    await expect(hook.flush()).rejects.toThrow('conflict')
    await act(async () => { hook.resolve(true); await hook.flush() })
    expect(saved.cells[0]!.content).toBe('local')
    await act(async () => hook.change([{ ...hook.cells![0]!, content: 'new edit' }]))
    saved = { ...saved, revision: saved.revision + 1, cells: [{ ...saved.cells[0]!, content: 'remote again' }] }
    await emit({ type: 'document', courseId: 'course', document: saved })
    await act(async () => hook.resolve(false))
    expect(hook.cells![0]!.content).toBe('remote again'); expect(hook.dirty).toBe(false)
  })
  it('retains unsaved source when disk writes fail and retries successfully', async () => {
    await act(async () => root.render(h(Harness)))
    save.mockRejectedValueOnce(new Error('Disk is full'))
    await act(async () => { hook.change([{ ...hook.cells![0]!, content: 'keep this' }]); await hook.flush().catch(() => {}) })
    expect(hook.error).toContain('Disk is full'); expect(hook.cells![0]!.content).toBe('keep this'); expect(hook.dirty).toBe(true)
    await act(async () => hook.flush())
    expect(saved.cells[0]!.content).toBe('keep this'); expect(hook.error).toBe('')
  })
  it('does not lose edits made while an earlier save is in flight', async () => {
    await act(async () => root.render(h(Harness)))
    let complete!: (result: unknown) => void
    save.mockImplementationOnce((_course, revision, cells) => new Promise(resolve => { complete = resolve; saved = { version: 1, revision: revision + 1, cells } }))
    let pending!: Promise<void>
    await act(async () => { hook.change([{ ...hook.cells![0]!, content: 'first' }]); pending = hook.flush() })
    await act(async () => { hook.change([{ ...hook.cells![0]!, content: 'second' }]); complete({ ok: true, document: structuredClone(saved) }); await pending })
    expect(saved.cells[0]!.content).toBe('second'); expect(hook.dirty).toBe(false)
  })
  it('keeps a conflict dirty if another window writes while a save is awaiting its response', async () => {
    await act(async () => root.render(h(Harness)))
    let complete!: (result: unknown) => void
    let ack!: NotebookDocument
    save.mockImplementationOnce((_course, revision, cells) => new Promise(resolve => { complete = resolve; ack = { version: 1, revision: revision + 1, cells } }))
    let pending!: Promise<void>
    await act(async () => { hook.change([{ ...hook.cells![0]!, content: 'local edit' }]); pending = hook.flush().catch(() => {}) })
    await emit({ type: 'document', courseId: 'course', document: { ...saved, revision: 2, cells: [{ ...saved.cells[0]!, content: 'remote edit' }] } })
    await act(async () => { complete({ ok: true, document: ack }); await pending })
    expect(hook.conflict).toBe(true); expect(hook.dirty).toBe(true); expect(hook.cells![0]!.content).toBe('local edit')
    await act(async () => hook.resolve(false))
  })
})
describe('Python lesson cells and editors', () => {
  it('resets transient state on leaving a workspace and rejects late execution events', async () => {
    const block = { type: 'python-cell' as const, slug: 'cell', nodeId: 'cell', content: 'original' }
    const render = async (sessionActive: boolean) => act(async () => root.render(h(LessonPythonCell, { block, courseId: 'course', sessionActive })))
    await render(true)
    await act(async () => codeView().dispatch({ changes: { from: 0, to: 8, insert: 'edited' } }))
    let finish!: (run: CellExecution) => void
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('.python-cell-run')!.click())
    const target = run.mock.calls[0]![0]
    const execution: CellExecution = { code: 'edited', status: 'complete', runId: crypto.randomUUID(), generation: crypto.randomUUID(), count: 1, outputs: [{ kind: 'stdout', text: '42' }], at: '' }
    await render(false)
    await emit({ type: 'execution', target, execution })
    await act(async () => finish(execution))
    await render(true)
    expect(codeView().state.doc.toString()).toBe('original'); expect(container.querySelector('.python-cell-output')).toBeNull(); expect(stop).toHaveBeenCalled()
  })
  it('Reset restores the course code and clears the output', async () => {
    const block = { type: 'python-cell' as const, slug: 'cell', nodeId: 'cell', content: 'original' }
    await act(async () => root.render(h(LessonPythonCell, { block, courseId: 'course' })))
    await act(async () => {})
    const reset = () => container.querySelector<HTMLButtonElement>('.python-cell-reset')!
    expect(reset().disabled).toBe(true)
    await act(async () => codeView().dispatch({ changes: { from: 0, to: 8, insert: 'edited' } }))
    run.mockResolvedValueOnce({ code: 'edited', status: 'complete', runId: crypto.randomUUID(), generation: crypto.randomUUID(), count: 1, outputs: [{ kind: 'stdout', text: '42' }], at: '' } satisfies CellExecution)
    await act(async () => container.querySelector<HTMLButtonElement>('.python-cell-run')!.click())
    expect(container.querySelector('.python-cell-output')?.textContent).toContain('42')
    expect(reset().disabled).toBe(false)
    await act(async () => reset().click())
    expect(codeView().state.doc.toString()).toBe('original'); expect(container.querySelector('.python-cell-output')).toBeNull()
    expect(stop).toHaveBeenCalled(); expect(reset().disabled).toBe(true)
  })
  it('runs with keyboard commands and preserves the selected code as a quote decoration', async () => {
    const onRun = vi.fn(), onAdvance = vi.fn(), offer = vi.fn<(value: AskOffer) => void>()
    await act(async () => root.render(h(AskProvider, { value: { offer, withdraw: vi.fn(), attach: vi.fn() } }, h(CodeEditor, {
      docKey: 'cell', language: 'python', indentUnit: '    ', initialDoc: 'value = 42', theme, autoHeight: true, askSource: 'notebook', cellId: 'cell', onRun, onRunAdvance: onAdvance, onChange: () => {}, onSave: () => {}
    }))))
    const editor = codeView()
    await act(async () => { editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })) })
    expect(onRun).toHaveBeenCalledOnce(); expect(onAdvance).toHaveBeenCalledOnce()
    vi.spyOn(editor, 'coordsAtPos').mockReturnValue({ left: 10, right: 20, top: 30, bottom: 40 })
    await act(async () => { editor.dispatch({ selection: { anchor: 0, head: 5 } }); editor.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await new Promise(resolve => requestAnimationFrame(resolve)) })
    expect(offer).toHaveBeenCalledWith(expect.objectContaining({ text: 'value', from: 'notebook', notebook: { cellId: 'cell' } }))
    await act(async () => { offer.mock.calls[0]![0].mark(); editor.dispatch({ selection: { anchor: 10 } }) })
    expect(container.querySelector('.python-quote-mark')?.textContent).toBe('value')
    await act(async () => offer.mock.calls[0]![0].unmark())
    expect(container.querySelector('.python-quote-mark')).toBeNull()
  })
})
