import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type JSX, type SetStateAction } from 'react'
import type { ChatQuote, CourseProgress, CourseView, UserProfile } from '@core/types'
import { MAX_NOTEBOOK_CELLS } from '@core/notebook/types'
import type { Route, Screen } from '../routes'
import Sidebar from '../components/Sidebar'
import TitleBar from '../components/TitleBar'
import ChatToggle from '../components/ChatToggle'
import SideChat from '../components/SideChat'
import ScreenPlaceholder from '../components/ScreenPlaceholder'
import ActionButton from '../components/ActionButton'
import { AskProvider, type Ask, type AskOffer } from '../ask-context'
import { useScreenActive } from '../screen-activity'
import { PythonCell } from '../notebook/PythonCell'
import { useNotebookStatus } from '../notebook/useNotebookStatus'
import { useNotebookDocument } from '../notebook/useNotebookDocument'
import { QUOTE_HIGHLIGHT } from '@core/vizbridge'

export interface NotebookHandle { flush: () => Promise<void>; dirty: () => boolean }
interface Props {
  courseId: string; user: UserProfile | null; navigate: (route: Route) => void; route: Screen
  chatOpen: boolean; setChatOpen: Dispatch<SetStateAction<boolean>>; textScale: number
  registerNotebook: (handle: NotebookHandle | null) => void
}
export default function Notebook({ courseId, user, navigate, route, chatOpen, setChatOpen, textScale, registerNotebook }: Props): JSX.Element {
  const [course, setCourse] = useState<CourseView | null>(null)
  const [progress, setProgress] = useState<CourseProgress | null>(null)
  const [error, setError] = useState('')
  const [offer, setOffer] = useState<AskOffer | null>(null)
  const [quote, setQuote] = useState<ChatQuote | null>(null)
  const marked = useRef<AskOffer | null>(null)
  const active = useScreenActive()
  const status = useNotebookStatus(courseId)
  const document = useNotebookDocument(courseId)
  const cellsRef = useRef(document.cells); cellsRef.current = document.cells
  const dirtyRef = useRef(document.dirty); dirtyRef.current = document.dirty
  useEffect(() => { registerNotebook({ flush: document.flush, dirty: () => dirtyRef.current }); return () => registerNotebook(null) }, [document.flush, registerNotebook])
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.opencourse.getCourse(courseId).then(value => { if (alive) setCourse(value) }); void window.opencourse.getProgress(courseId).then(value => { if (alive) setProgress(value) }) }
    refresh(); const off = window.opencourse.onCoursesChanged(refresh)
    return () => { alive = false; off() }
  }, [courseId])
  const attach = useCallback((selection: AskOffer): void => {
    marked.current?.unmark(); selection.mark(); marked.current = selection
    setQuote({ text: selection.text, from: selection.from, ...(selection.notebook ? { notebook: selection.notebook } : {}) }); setOffer(null); setChatOpen(true)
  }, [setChatOpen])
  const ask = useMemo<Ask>(() => ({ offer: setOffer, withdraw: owner => setOffer(current => current?.owner === owner ? null : current), attach }), [attach])
  useEffect(() => { if (!quote) { marked.current?.unmark(); marked.current = null } }, [quote])
  useEffect(() => () => marked.current?.unmark(), [])
  useEffect(() => {
    if (!active) return
    const select = (event: MouseEvent): void => {
      if ((event.target as Element)?.closest('.ask-about')) return
      const selection = window.getSelection()
      if (!selection?.rangeCount || !selection.toString().trim()) { setOffer(null); return }
      const range = selection.getRangeAt(0), node = range.commonAncestorContainer
      const element = node instanceof Element ? node : node.parentElement
      if (element?.closest('.cm-editor')) return
      const region = element?.closest('[data-ask]'), from = region?.getAttribute('data-ask')
      if ((from !== 'notebook' && from !== 'answer') || !region?.contains(range.startContainer) || !region.contains(range.endContainer)) { setOffer(null); return }
      const box = range.getBoundingClientRect(), saved = range.cloneRange(), owner = region!
      const highlight = (value: Range | null): void => {
        if (typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined') { if (value) CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(value)); else CSS.highlights.delete(QUOTE_HIGHLIGHT) }
      }
      setOffer({ owner, from, text: selection.toString(), x: box.left + box.width / 2, y: box.top,
        ...(from === 'notebook' ? { notebook: { cellId: element?.closest('[data-cell-id]')?.getAttribute('data-cell-id') ?? undefined } } : {}),
        mark: () => highlight(saved), unmark: () => highlight(null) })
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) { setChatOpen(false); setOffer(null) } }
    window.addEventListener('mouseup', select); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mouseup', select); window.removeEventListener('keydown', escape) }
  }, [active, setChatOpen])
  const add = (): void => { if (document.cells && document.cells.length < MAX_NOTEBOOK_CELLS) document.change([...document.cells, { id: crypto.randomUUID(), content: '' }]) }
  const run = async (id: string, advance = false): Promise<void> => {
    if (status?.kernel === 'busy' || status?.kernel === 'stopping') return
    setError('')
    try {
      await document.flush()
      await window.opencourse.runPythonCell({ courseId, cellId: id, kind: 'notebook', requestId: crypto.randomUUID() })
      if (advance) {
        const cells = cellsRef.current ?? []
        const index = cells.findIndex(cell => cell.id === id)
        const next = cells[index + 1]
        if (next) requestAnimationFrame(() => globalThis.document.querySelector<HTMLElement>(`[data-cell-id="${next.id}"] .cm-content`)?.focus())
        else if (index === cells.length - 1 && cells.length < MAX_NOTEBOOK_CELLS) { const next = { id: crypto.randomUUID(), content: '' }; document.change([...cells, next]); requestAnimationFrame(() => globalThis.document.querySelector<HTMLElement>(`[data-cell-id="${next.id}"] .cm-content`)?.focus()) }
      }
    } catch (error) { setError((error as Error).message) }
  }
  const stop = (restart = false): void => { void window.opencourse.stopNotebook(courseId, restart).catch(error => setError(error.message)) }
  if (!course || !progress || !document.cells) return <><ScreenPlaceholder />{document.error && <p className="error">{document.error}</p>}</>
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: course.title, onClick: () => navigate({ name: 'course', courseId }) }} actions={<ChatToggle open={chatOpen} onClick={() => setChatOpen(value => !value)} subject="notebook" />} />
    <AskProvider value={ask}><div className="body lesson-body notebook-body">
      <Sidebar course={course} current={{ notebook: true }} progress={progress} navigate={navigate} />
      <div className="content scroll"><div className="content-inner notebook-inner">
        <div className="notebook-heading"><h1>Notebook</h1><span className="spacer" /><span className="meta">{status?.kernel ?? 'stopped'} · {document.dirty ? 'Saving…' : 'Saved'}</span>
          <ActionButton icon="stop" className="secondary" disabled={status?.kernel === 'stopped' || status?.kernel === 'stopping'} onClick={() => stop()}>Stop kernel</ActionButton>
          <ActionButton icon="restart" className="secondary" disabled={status?.stage !== 'ready' || status?.kernel === 'stopping'} onClick={() => stop(true)}>Restart kernel</ActionButton></div>
        <p className="meta">Cells share Python variables until you stop or restart the kernel. Installed packages stay in this course’s environment.</p>
        <details className="notebook-help"><summary>Install a Python package</summary><p>Run this in a cell, replacing the package name:</p><pre>{'import subprocess, sys\nsubprocess.check_call([sys.executable, "-m", "pip", "install", "package-name"])'}</pre><p className="meta">Restart the kernel if an already imported package was upgraded.</p></details>
        {(error || document.error) && <p className="error">{error || document.error}</p>}
        {document.conflict && <div className="notebook-conflict"><ActionButton icon="save" onClick={() => document.resolve(true)}>Keep my edits</ActionButton><ActionButton icon="refresh" className="secondary" onClick={() => document.resolve(false)}>Reload saved notebook</ActionButton></div>}
        {document.cells.map((cell, index) => <div key={cell.id} className="notebook-cell-wrap">
          <PythonCell cellId={cell.id} content={cell.content} execution={cell.execution} askSource="notebook" textScale={textScale}
            busy={status?.runningCellId === cell.id} disabled={status?.stage !== 'ready' || status.kernel === 'busy' || status.kernel === 'stopping'} onRun={() => void run(cell.id)} onRunAdvance={() => void run(cell.id, true)} onSave={() => void document.flush().catch(() => {})} onStop={() => stop()}
            onChange={content => document.change(document.cells!.map(old => old.id === cell.id ? { ...old, content } : old))} />
          <div className="notebook-cell-actions">
            <ActionButton icon="up" className="ghost" disabled={index === 0} onClick={() => { const cells = [...document.cells!]; [cells[index - 1], cells[index]] = [cells[index]!, cells[index - 1]!]; document.change(cells) }}>Move up</ActionButton>
            <ActionButton icon="down" className="ghost" disabled={index === document.cells!.length - 1} onClick={() => { const cells = [...document.cells!]; [cells[index + 1], cells[index]] = [cells[index]!, cells[index + 1]!]; document.change(cells) }}>Move down</ActionButton>
            <ActionButton icon="eraser" className="ghost" disabled={status?.runningCellId === cell.id} onClick={() => void document.flush().then(() => window.opencourse.clearNotebookOutput(courseId, cell.id)).catch(error => setError(error.message))}>Clear output</ActionButton>
            <ActionButton icon="trash" className="ghost" disabled={status?.runningCellId === cell.id} onClick={() => document.change(document.cells!.filter(old => old.id !== cell.id))}>Delete cell</ActionButton>
          </div>
        </div>)}
        {!document.cells.length && <p>Add a Python cell to start experimenting.</p>}
        <ActionButton icon="plus" className="secondary notebook-add" disabled={document.cells.length >= MAX_NOTEBOOK_CELLS} onClick={add}>Add cell</ActionButton>
      </div></div>
      <div className="lesson-chat-host" hidden={!chatOpen}><SideChat visible={chatOpen} courseId={courseId} notebook beforeSend={document.flush} quote={quote} onQuoteUsed={() => setQuote(null)} onClose={() => setChatOpen(false)} onAddKey={() => navigate({ name: 'settings', from: route, section: 'connections' })} textScale={textScale} /></div>
    </div>{active && offer && <button className="ask-about" style={{ left: Math.min(Math.max(offer.x, 64), window.innerWidth - 64), top: offer.y }} onMouseDown={event => event.preventDefault()} onClick={() => attach(offer)}>Ask about this</button>}</AskProvider>
  </>
}
