import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import type { CoachContextReply, CoachContextRequest, CoachOpenContent } from '@core/coach/context'

type Provider = (request: CoachContextRequest) => CoachOpenContent | CoachContextReply | null
const providers = new Set<Provider>()

export function useCoachContextProvider(provider: Provider): void {
  const current = useRef(provider)
  useLayoutEffect(() => { current.current = provider })
  useEffect(() => {
    const read: Provider = request => current.current(request)
    providers.add(read)
    return () => { providers.delete(read) }
  }, [])
}

export function useCoachContextBridge(userId?: string | null): void {
  useEffect(() => {
    if (userId === null) return
    return window.opencourse.onCoachContextRequest?.(request => {
      if (userId !== undefined && request.userId !== userId) {
        window.opencourse.replyCoachContext(request.requestId, { error: 'The learner changed. Request context again.' }); return
      }
      try {
        const values = [...providers].map(read => read(request)).filter(value => value !== null)
        const reply: CoachContextReply = request.tool === 'get_app_context'
          ? { entries: values.filter((value): value is CoachOpenContent => 'kind' in value).slice(0, 8) }
          : (values.find((value): value is CoachContextReply => 'value' in value || 'error' in value) ?? {})
        window.opencourse.replyCoachContext(request.requestId, reply)
      } catch {
        window.opencourse.replyCoachContext(request.requestId, { error: 'The open content could not be read. Try again.' })
      }
    })
  }, [userId])
}

/** Read editor state, including selections outside CodeMirror's rendered viewport. */
export function selectedContent(root: Element | null): Pick<CoachOpenContent, 'selectedText' | 'selectionTruncated' | 'selectionPage' | 'cellId'> {
  if (!root || root.closest('[hidden], [inert]')) return { selectedText: '' }
  const selection = window.getSelection()
  if (selection?.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0)
    if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
      const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      // Browser selections in CodeMirror may only contain its visible viewport; use editor state below.
      if (!element?.closest('.cm-editor')) {
        const text = selection.toString(), page = element?.closest('[data-page]')?.getAttribute('data-page')
        return { selectedText: text.slice(0, 2400), selectionTruncated: text.length > 2400,
          ...(page ? { selectionPage: Number(page) } : {}),
          ...(element?.closest('[data-cell-id]') ? { cellId: element.closest('[data-cell-id]')!.getAttribute('data-cell-id')! } : {}) }
      }
    } else return { selectedText: '' }
  }
  const editors = [...root.querySelectorAll<HTMLElement>('.cm-editor')]
    .map(element => ({ element, view: EditorView.findFromDOM(element) }))
    .filter(item => item.view && !item.element.closest('[hidden], [inert]'))
  const editor = editors.find(item => item.view!.hasFocus)
    ?? editors.find(item => !!selection?.anchorNode && item.element.contains(selection.anchorNode))
    ?? editors.find(item => !item.view!.state.selection.main.empty)
  if (!editor) return { selectedText: '' }
  const state = editor.view!.state, range = state.selection.main
  const text = state.sliceDoc(range.from, Math.min(range.to, range.from + 2400))
  const cellId = editor.element.closest('[data-cell-id]')?.getAttribute('data-cell-id')
  return { selectedText: text, selectionTruncated: range.to - range.from > 2400, ...(cellId ? { cellId } : {}) }
}
export function contextExcerpt(text: string): Pick<CoachOpenContent, 'excerpt' | 'excerptTruncated'> {
  return { excerpt: text.slice(0, 1000), excerptTruncated: text.length > 1000 }
}
