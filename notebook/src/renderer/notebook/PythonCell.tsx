import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PythonCellBlock, QuoteSource } from '@core/types'
import type { CellExecution } from '@core/notebook/types'
import CodeEditor from '../workbench/CodeEditor'
import { useWorkbenchTheme } from '../workbench/theme'
import { useNotebookStatus } from './useNotebookStatus'
import ActionButton from '../components/ActionButton'

export function PythonCell({ cellId, content, onChange, execution, busy = false, disabled = false, onRun, onRunAdvance, onStop, onReset, resetDisabled = false, onSave = () => {}, askSource = 'lesson', textScale = 1 }: {
  cellId: string; content: string; onChange: (code: string) => void; execution?: CellExecution; busy?: boolean; disabled?: boolean
  onRun: () => void; onRunAdvance?: () => void; onStop: () => void; onReset?: () => void; resetDisabled?: boolean; onSave?: () => void; askSource?: QuoteSource; textScale?: number
}): JSX.Element {
  const theme = useWorkbenchTheme()
  return <section className="python-cell panel" data-cell-id={cellId}>
    <div className="python-cell-toolbar"><span className="meta">{execution ? `[${execution.count}] · ${execution.status}` : 'Python'}</span><span className="spacer" />
      {onReset && <ActionButton icon="reset" className="secondary python-cell-reset" disabled={resetDisabled} onClick={onReset}>Reset</ActionButton>}
      {busy ? <ActionButton icon="stop" className="secondary python-cell-stop" onClick={onStop}>Stop</ActionButton> : <ActionButton icon="play" className="python-cell-run" disabled={disabled} onClick={onRun}>Run</ActionButton>}
    </div>
    <CodeEditor docKey={cellId} language="python" indentUnit="    " initialDoc={content} value={content} theme={theme} textScale={textScale} autoHeight askSource={askSource} cellId={cellId}
      onChange={onChange} onSave={onSave} onRun={() => { if (!disabled && !busy) onRun() }} onRunAdvance={onRunAdvance ? () => { if (!disabled && !busy) onRunAdvance() } : undefined} />
    {execution && <div className="python-cell-output" data-ask={askSource}>
      {execution.code !== content && <p className="meta">Output is from an earlier version of this code.</p>}
      {execution.outputs.map((output, index) => <pre key={index} className={output.kind === 'stderr' ? 'python-cell-stderr' : undefined}>{output.text}</pre>)}
      {execution.truncated && <p className="meta">Output truncated at 1 MiB.</p>}
    </div>}
  </section>
}
export default function LessonPythonCell({ block, courseId, textScale = 1, sessionActive = true }: { block: PythonCellBlock; courseId: string; textScale?: number; sessionActive?: boolean }): JSX.Element {
  const [content, setContent] = useState(block.content)
  useEffect(() => { setContent(block.content) }, [block.content])
  const [execution, setExecution] = useState<CellExecution>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const status = useNotebookStatus(courseId)
  const alive = useRef(true)
  const active = useRef(sessionActive); active.current = sessionActive
  const request = useRef<string | undefined>(undefined)
  const target = useMemo(() => ({ courseId, cellId: block.nodeId!, kind: 'lesson' as const }), [courseId, block.nodeId])
  useEffect(() => {
    alive.current = true
    const off = window.opencourse.onNotebookEvent(event => {
      if (active.current && event.type === 'execution' && event.target.requestId === request.current && event.target.kind === 'lesson' && event.target.courseId === courseId && event.target.cellId === target.cellId) setExecution(event.execution)
    })
    return () => { alive.current = false; request.current = undefined; off(); void window.opencourse.stopLessonCell(target).catch(() => {}) }
  }, [target, courseId])
  // Back to the course's code with no output; a run still going is stopped and its late result ignored.
  const reset = useCallback((): void => {
    request.current = undefined; setContent(block.content); setExecution(undefined); setError('')
    void window.opencourse.stopLessonCell(target).catch(() => {})
  }, [block.content, target])
  useEffect(() => { if (!sessionActive) reset() }, [sessionActive, reset])
  const run = async (): Promise<void> => {
    if (busy) return
    const requestId = crypto.randomUUID(); request.current = requestId
    setBusy(true); setError('')
    try { const result = await window.opencourse.runPythonCell({ ...target, requestId }, content); if (alive.current && active.current && request.current === requestId) setExecution(result) }
    catch (error) { if (alive.current && active.current) setError((error as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }
  return <><PythonCell cellId={target.cellId} content={content} onChange={setContent} execution={execution} busy={busy} disabled={status?.stage !== 'ready'} textScale={textScale} onRun={() => void run()} onReset={reset} resetDisabled={!busy && !execution && !error && content === block.content} onStop={() => void window.opencourse.stopLessonCell(target).catch(error => setError(error.message))} />
    {status?.stage !== 'ready' && <p className="meta">{status?.stage === 'failed' ? 'Notebook setup failed. Use Retry in the sidebar.' : 'Creating notebook environment…'}</p>}
    {error && <p className="error">{error}</p>}</>
}
