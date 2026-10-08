import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CodeEditor from '../src/renderer/workbench/CodeEditor'
import type { WorkbenchTheme } from '../src/renderer/workbench/theme'

const theme: WorkbenchTheme = { dark: true, fg: '#eee', bg: '#111', muted: '#aaa', accent: '#ddd', border: '#444', ok: '#0f0', err: '#f00', scrollbar: '#333', scrollbarHover: '#555', activeLine: 'rgba(255, 255, 255, 0.04)', selection: 'rgba(196, 196, 205, 0.18)', mono: 'ui-monospace, monospace' }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
describe('controlled authoring code buffers', () => {
  it('reflects external draft edits without sending them back as user edits, while keeping typed changes', async () => {
    const change = vi.fn()
    const render = async (value: string) => act(async () => root.render(createElement(CodeEditor, { docKey: 'starter', language: 'python', indentUnit: '    ', initialDoc: value, value, theme, onChange: change, onSave: () => {}, onRun: () => {} })))
    await render('print(1)')
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(2)' } }))
    expect(change).toHaveBeenLastCalledWith('print(2)')
    await render('print(2)')
    expect(EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)).toBe(view)
    await render('AI edited buffer')
    expect(view.state.doc.toString()).toBe('AI edited buffer')
    expect(change).toHaveBeenCalledOnce()
  })
  it('makes preview buffers read-only, unlocks them for editing and loads a newly selected file', async () => {
    const render = async (docKey: string, value: string, readOnly: boolean) => act(async () => root.render(createElement(CodeEditor, { docKey, language: 'python', indentUnit: '    ', initialDoc: value, value, readOnly, ariaLabel: 'Preset file', theme, onChange: () => {}, onSave: () => {}, onRun: () => {} })))
    await render('starter', 'starter', true)
    expect(container.querySelector('[aria-label="Preset file"]')?.getAttribute('contenteditable')).toBe('false')
    await render('starter', 'starter', false)
    expect(container.querySelector('[aria-label="Preset file"]')?.getAttribute('contenteditable')).toBe('true')
    await render('support', 'support content', false)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(view.state.doc.toString()).toBe('support content')
    await render('support', 'AI changed support', true)
    expect(container.querySelector('[aria-label="Preset file"]')?.getAttribute('contenteditable')).toBe('false')
    expect(EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString()).toBe('AI changed support')
  })
})
