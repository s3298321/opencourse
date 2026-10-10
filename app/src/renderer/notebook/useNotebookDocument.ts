import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotebookCell, NotebookDocument } from '@core/notebook/types'
const sources = (cells: NotebookCell[]): string => JSON.stringify(cells.map(({ id, content }) => ({ id, content })))
export function useNotebookDocument(courseId: string) {
  const [cells, setCells] = useState<NotebookCell[] | null>(null)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [dirty, setDirty] = useState(false)
  const state = useRef<{ server?: NotebookDocument; local?: NotebookCell[]; requested?: NotebookCell[]; version: number; saved: number; blocked: boolean; saving?: Promise<void>; alive: boolean }>({ version: 0, saved: 0, blocked: false, alive: true })
  const receive = useCallback((document: NotebookDocument): void => {
    const s = state.current
    if (s.server && document.revision < s.server.revision) return
    const pending = s.version !== s.saved
    if (pending && s.server && sources(document.cells) !== sources(s.server.cells) && sources(document.cells) !== sources(s.requested ?? [])) {
      s.server = document; s.blocked = true
      if (s.alive) { setConflict(true); setError('The notebook changed in another window. Your edits are still here. Choose which version to keep.') }
      return
    }
    s.server = document
    if (!pending) s.local = document.cells
    else {
      const outputs = new Map(document.cells.map(cell => [cell.id, cell.execution]))
      s.local = s.local?.map(cell => ({ ...cell, execution: outputs.get(cell.id) }))
    }
    if (s.alive) setCells(s.local ?? document.cells)
  }, [])
  const flush = useCallback(async (): Promise<void> => {
    const s = state.current
    if (s.saving) { await s.saving; return flush() }
    if (s.blocked) throw new Error('Resolve the notebook save conflict before continuing.')
    const task = (async () => {
      while (s.version !== s.saved && s.server && s.local) {
        const version = s.version, requested = structuredClone(s.local), revision = s.server.revision
        s.requested = requested
        const result = await window.opencourse.saveNotebook(courseId, revision, requested.map(({ id, content }) => ({ id, content })))
        if (s.blocked) throw new Error('The notebook changed in another window. Your edits have been retained.')
        if (!result.ok) {
          // Output writes may have advanced the revision without changing source.
          if (sources(result.document.cells) === sources(s.server.cells)) { receive(result.document); continue }
          s.server = result.document; s.blocked = true
          if (s.alive) setConflict(true)
          throw new Error('The notebook changed in another window. Your edits have been retained.')
        }
        s.saved = version
        receive(result.document)
        if (s.alive) { setDirty(s.version !== s.saved); setError('') }
      }
    })()
    s.saving = task
    try { await task }
    catch (error) { if (s.alive) setError((error as Error).message); throw error }
    finally { s.saving = undefined; s.requested = undefined }
  }, [courseId, receive])
  const change = useCallback((next: NotebookCell[]): void => {
    const s = state.current
    s.local = next; s.version++
    setCells(next); setDirty(true)
  }, [])
  useEffect(() => {
    const s = state.current; s.alive = true
    const off = window.opencourse.onNotebookEvent(event => { if (event.type === 'document' && event.courseId === courseId) receive(event.document) })
    void window.opencourse.getNotebook(courseId).then(document => { if (s.alive) receive(document) }).catch(error => { if (s.alive) setError(error.message) })
    return () => { s.alive = false; off(); void flush().catch(() => {}) }
  }, [courseId, receive, flush])
  useEffect(() => {
    if (!dirty || conflict) return
    const timer = window.setTimeout(() => void flush().catch(() => {}), 300)
    return () => window.clearTimeout(timer)
  }, [cells, dirty, conflict, flush])
  const resolve = useCallback((keepLocal: boolean): void => {
    const s = state.current
    s.blocked = false; setConflict(false); setError('')
    if (keepLocal) void flush().catch(() => {})
    else { s.saved = s.version; s.local = s.server?.cells; setCells(s.local ?? []); setDirty(false) }
  }, [flush])
  return { cells, change, flush, error, conflict, dirty, resolve, receive }
}
