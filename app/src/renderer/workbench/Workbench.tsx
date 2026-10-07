import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { CourseProgress, ExerciseSession, ExerciseTarget } from '@core/types'
import CodeEditor from './CodeEditor'
import TerminalView from './TerminalView'
import TestPanel, { type TestPanelHandle } from './TestPanel'
import { useWorkbenchTheme } from './theme'

interface Props {
  target: ExerciseTarget
  title: string
  /** Last recorded verdict, so reopening does not look like a blank slate. */
  lastRun?: { at: string; passed: boolean }
  /** Straight from the manifest; the renderer already has it. */
  starterCode: string
  /** The exercise itself - prompt, how to verify, hints - kept beside the editor. */
  brief: ReactNode
  onClose: () => void
  onProgress: (progress: CourseProgress) => void
}

type Tab = 'tests' | 'terminal'
type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'passed'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'error'; message: string; detail?: string }

const AUTOSAVE_MS = 800
const MIN_PANE = 120
/**
 * The brief's floor, and the editor's while you drag. The window's own minimum
 * is 720px and the chapter list keeps 268 of it, so these leave the row able to
 * fit without scrolling sideways; CSS holds the editor at its own, lower floor.
 */
const MIN_BRIEF = 200
const MIN_EDITOR = 360
const BRIEF_SHARE = 0.38
const MAX_INITIAL_BRIEF = 520
const SIDEBAR_WIDTH = 268

/** Wide enough to read the task in, without taking the editor's room on a laptop. */
function initialBriefWidth(): number {
  const room = window.innerWidth - SIDEBAR_WIDTH
  return Math.round(Math.max(MIN_BRIEF, Math.min(MAX_INITIAL_BRIEF, room * BRIEF_SHARE)))
}

export default function Workbench({
  target,
  title,
  lastRun,
  starterCode,
  brief,
  onClose,
  onProgress
}: Props): JSX.Element {
  const theme = useWorkbenchTheme()
  const [session, setSession] = useState<ExerciseSession | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('tests')
  // The shell is spawned the first time the Terminal tab is opened, not when
  // the workbench mounts. Starting an interactive zsh is expensive - node-pty's
  // spawn is synchronous and a heavy ~/.zshrc blocks the main process while it
  // runs - so it must not sit on the critical path of every open, for a pane
  // most runs never look at. Once started it stays mounted across tab switches.
  const [terminalStarted, setTerminalStarted] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<{ content: string; mtimeMs: number } | null>(null)
  const [running, setRunning] = useState(false)
  const [editorRevision, setEditorRevision] = useState(0)
  const [bottomHeight, setBottomHeight] = useState(240)
  const [briefWidth, setBriefWidth] = useState(initialBriefWidth)

  const buffer = useRef('')
  const mtime = useRef<number | null>(null)
  const tests = useRef<TestPanelHandle | null>(null)
  const autosave = useRef<number | undefined>(undefined)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const rowRef = useRef<HTMLElement | null>(null)

  const exerciseKey = `${target.courseId}/${target.blockId}`
  // Before the session lands we do not know the language, so the generic name
  // is the honest placeholder for the conflict copy.
  const learnerFile = session?.learnerFile ?? 'your file'

  /* --- load ------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false
    setSession(null)
    setLoadError(null)
    setStatus(
      lastRun
        ? {
            kind: lastRun.passed ? 'passed' : 'failed',
            message: lastRun.passed
              ? 'Passed last time you ran the checks.'
              : 'Did not pass last time you ran the checks.'
          }
        : { kind: 'idle' }
    )
    setConflict(null)
    setDirty(false)
    window.opencourse
      .openExercise(target)
      .then((next) => {
        if (cancelled) return
        buffer.current = next.content
        mtime.current = next.mtimeMs
        setSession(next)
        setEditorRevision((n) => n + 1)
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
    // lastRun is the value at open time; later runs set the status directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseKey, target])

  /* --- saving ----------------------------------------------------------- */
  const save = useCallback(
    async (force = false): Promise<boolean> => {
      if (!session) return false
      const result = await window.opencourse.writeExerciseFile(target, buffer.current, force ? null : mtime.current)
      if (result.ok) {
        mtime.current = result.mtimeMs
        setDirty(false)
        setConflict(null)
        return true
      }
      if (result.reason === 'conflict') {
        // Someone edited the file outside the editor - the Terminal tab, or
        // another editor. If nothing local is at stake, just take theirs;
        // otherwise make the learner choose.
        if (!dirty) {
          buffer.current = result.content
          mtime.current = result.mtimeMs
          setEditorRevision((n) => n + 1)
          return true
        }
        setConflict({ content: result.content, mtimeMs: result.mtimeMs })
      } else {
        setStatus({ kind: 'error', message: 'That file is too large to save.' })
      }
      return false
    },
    [session, target, dirty]
  )

  const onChange = useCallback((value: string) => {
    buffer.current = value
    setDirty(true)
    window.clearTimeout(autosave.current)
    autosave.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
    // save is stable enough for the debounce; a stale closure would only cost
    // one extra round trip, and the run path always saves explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save])

  useEffect(() => () => window.clearTimeout(autosave.current), [])

  /* --- running ---------------------------------------------------------- */
  useEffect(() => {
    const offRun = window.opencourse.onRunData((id, chunk) => {
      if (id === target.blockId) tests.current?.write(chunk)
    })
    const offEnv = window.opencourse.onEnvProgress((id, progress) => {
      if (id !== target.blockId) return
      setStatus({ kind: 'busy', message: progress.message })
      if (progress.stage !== 'ready') tests.current?.write(`\x1b[2m${progress.message}\x1b[0m\r\n`)
    })
    return () => {
      offRun()
      offEnv()
    }
  }, [target.blockId])

  const run = useCallback(async (): Promise<void> => {
    if (!session || running) return
    window.clearTimeout(autosave.current)
    setTab('tests')
    setRunning(true)
    setStatus({ kind: 'busy', message: 'Running the checks…' })
    tests.current?.clear()

    try {
      const result = await window.opencourse.runTests(target, buffer.current, mtime.current, tests.current?.cols() ?? 80)
      if (result.status === 'conflict') {
        setConflict({ content: result.content, mtimeMs: result.mtimeMs })
        setStatus({ kind: 'error', message: `${learnerFile} changed outside the app.` })
        return
      }
      if (result.status === 'unsupported') {
        // The toolchain words the reason; repeating a language here is how the
        // old copy ended up claiming everything was pytest.
        setStatus({
          kind: 'error',
          message: `OpenCourse cannot run this in-app: ${result.reason}.`,
          detail: 'Use the Terminal tab to run it yourself.'
        })
        return
      }
      if (result.status === 'env') {
        const error = result.error
        setStatus({
          kind: 'error',
          message: error.ok ? 'Setup failed.' : error.message,
          detail: !error.ok && error.code === 'no-tool' ? error.hint.join('  ') : undefined
        })
        return
      }

      setDirty(false)
      mtime.current = (await window.opencourse.readExerciseFile(target)).mtimeMs
      onProgress(result.progress)
      if (result.outcome.cancelled) setStatus({ kind: 'idle' })
      else if (result.outcome.timedOut) {
        setStatus({ kind: 'error', message: 'The checks ran too long and were stopped.' })
      } else if (result.outcome.exitCode === 0) {
        setStatus({ kind: 'passed', message: 'All checks passed — exercise complete.' })
      } else if (result.outcome.failedStep === 'compile') {
        setStatus({ kind: 'failed', message: 'It did not compile yet — read the errors below.' })
      } else {
        setStatus({ kind: 'failed', message: 'Some checks did not pass yet.' })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }, [session, running, target, onProgress])

  /* --- the splitters ----------------------------------------------------- */
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const shell = shellRef.current
    if (!shell) return
    const onMove = (move: PointerEvent): void => {
      const rect = shell.getBoundingClientRect()
      const next = rect.bottom - move.clientY
      setBottomHeight(Math.max(MIN_PANE, Math.min(rect.height - MIN_PANE, next)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // Between the brief and the editor. The brief is the one that is sized: the
  // editor takes what is left, so a window resize lands on the brief first.
  const startBriefDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const row = rowRef.current
    if (!row) return
    const onMove = (move: PointerEvent): void => {
      const rect = row.getBoundingClientRect()
      const room = Math.max(MIN_BRIEF, rect.width - MIN_EDITOR)
      setBriefWidth(Math.max(MIN_BRIEF, Math.min(room, move.clientX - rect.left)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const resetToStarter = useCallback(async (): Promise<void> => {
    if (!session) return
    if (!window.confirm('Replace your code with the original starter? This cannot be undone.')) return
    buffer.current = starterCode
    setEditorRevision((n) => n + 1)
    await window.opencourse.writeExerciseFile(target, starterCode, null)
    mtime.current = (await window.opencourse.readExerciseFile(target)).mtimeMs
    setDirty(false)
  }, [session, target, starterCode])

  // The task stays on screen while you write the code: the brief on the left,
  // the editor on the right, and the chapter list still left of both.
  const briefColumn = (
    <>
      <section className="workbench-brief" style={{ width: briefWidth, flex: '0 1 auto' }} aria-label="Exercise">
        <button className="secondary workbench-back" onClick={onClose} title="Back to the lesson">
          ← Back to lesson
        </button>
        {brief}
      </section>
      <div
        className="workbench-grip"
        onPointerDown={startBriefDrag}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
      />
    </>
  )

  if (loadError) {
    return (
      <aside className="workbench" ref={rowRef}>
        {briefColumn}
        <div className="workbench-main">
          <div className="workbench-head">
            <strong>{title}</strong>
          </div>
          <div className="workbench-error">Could not open this exercise: {loadError}</div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="workbench" ref={rowRef}>
      {briefColumn}
      <div className="workbench-main" ref={shellRef}>
        <div className="workbench-head">
          <strong title={title}>{title}</strong>
          {session && (
            <span className="workbench-lang" title={`${session.languageLabel} — you are editing ${session.learnerFile}`}>
              {session.languageLabel}
            </span>
          )}
          <span className={`save-state${dirty ? ' dirty' : ''}`}>{dirty ? 'Unsaved' : 'Saved'}</span>
        </div>

        {conflict && (
          <div className="workbench-conflict">
            <span>{learnerFile} changed outside the app.</span>
            <button
              onClick={() => {
                buffer.current = conflict.content
                mtime.current = conflict.mtimeMs
                setEditorRevision((n) => n + 1)
                setDirty(false)
                setConflict(null)
              }}
            >
              Load theirs
            </button>
            <button className="secondary" onClick={() => void save(true)}>Keep mine</button>
          </div>
        )}

        <div className="workbench-editor">
          {session && (
            <CodeEditor
              docKey={`${exerciseKey}#${editorRevision}`}
              language={session.language}
              indentUnit={session.indentUnit}
              initialDoc={buffer.current}
              theme={theme}
              onChange={onChange}
              onSave={() => void save()}
              onRun={() => void run()}
            />
          )}
        </div>

        <div className="workbench-actions">
          <button onClick={() => void run()} disabled={!session || running || !session.canRun}>
            {running ? 'Running…' : 'Run checks'}
          </button>
          {running && (
            <button className="secondary" onClick={() => void window.opencourse.cancelRun()}>Stop</button>
          )}
          <button className="secondary" onClick={() => void resetToStarter()} disabled={!session}>Reset</button>
          <span className={`run-status ${status.kind}`}>
            {status.kind !== 'idle' && status.message}
            {status.kind === 'error' && status.detail && <em> {status.detail}</em>}
          </span>
        </div>

        <div className="workbench-split" onPointerDown={startDrag} role="separator" aria-orientation="horizontal" />

        <div className="workbench-bottom" style={{ height: bottomHeight }}>
          <div className="workbench-tabs">
            <button className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}>Checks</button>
            <button
              className={tab === 'terminal' ? 'active' : ''}
              onClick={() => {
                setTerminalStarted(true)
                setTab('terminal')
              }}
            >
              Terminal
            </button>
          </div>
          <div className="workbench-panes">
            {/* Both panes stay mounted: a display:none xterm has no size, and
                fitting one produces NaN columns and a corrupted buffer. */}
            <div className={`pane${tab === 'tests' ? ' active' : ''}`}>
              <TestPanel theme={theme} visible={tab === 'tests'} handleRef={tests} />
            </div>
            <div className={`pane${tab === 'terminal' ? ' active' : ''}`}>
              {session && terminalStarted && (
                <TerminalView
                  sessionId={`${target.blockId}-shell`}
                  cwd={session.exerciseDir}
                  envDir={session.envDir}
                  language={session.language}
                  theme={theme}
                  visible={tab === 'terminal'}
                  onExit={() => undefined}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
