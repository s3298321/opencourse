import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { ArrowLeft, Check, Monitor, RotateCcw, SquareTerminal } from 'lucide-react'
import type { ExerciseBlock } from '@core/types'
import type { LearningField } from '@core/learning/types'
import { MAX_EXERCISE_CODE } from '@core/learning/types'
import { Html } from './Html'
import { renderMarkdown } from '../lib/markdown'
import { server } from '../lib/boot'

/**
 * An exercise, as the app shows it. `lesson` is the card in the lesson; `brief`
 * is the same exercise beside the editor, without what the editor already has -
 * the button that opens it and the starter code, which is the buffer itself.
 * Hints, the solution and how it is checked never reach the browser.
 */
export function ExerciseCard({
  block,
  mode = 'lesson',
  done,
  started,
  onOpen,
  onToggleDone
}: {
  block: ExerciseBlock
  mode?: 'lesson' | 'brief'
  done: boolean
  started: boolean
  onOpen?: () => void
  onToggleDone: (done: boolean) => void
}) {
  const brief = mode === 'brief'
  return (
    <div className={brief ? 'web-exercise exercise-brief' : 'oc-panel learning-card web-exercise'}>
      <h3>Exercise: {block.title}</h3>
      <Html className="oc-prose prompt" html={renderMarkdown(block.prompt)} />
      {!brief && block.starter_code && (
        <details>
          <summary>Starter code</summary>
          <pre>
            <code>{block.starter_code}</code>
          </pre>
        </details>
      )}
      <div className="exercise-actions">
        {!brief && onOpen && (
          <button className="oc-btn" onClick={onOpen}>
            <SquareTerminal /> {started ? 'Continue exercise' : 'Start exercise'}
          </button>
        )}
        <button
          className={`oc-btn${done ? ' secondary' : ''} exercise-done`}
          aria-pressed={done}
          onClick={() => onToggleDone(!done)}
        >
          <Check /> {done ? 'Completed' : 'Mark completed'}
        </button>
      </div>
    </div>
  )
}

// CodeMirror and its language modes are most of a megabyte: fetched when a
// workspace first opens, not with every page.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

const AUTOSAVE_MS = 800
const MIN_BRIEF = 200
const MIN_EDITOR = 360

type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed' | 'too-large'

/**
 * The exercise workspace: the brief, the editor, and where the app has its
 * checks and terminal, a note that they run there. The code is saved as
 * progress (`code:<exercise>`), so the app opens on the same text.
 */
export function ExerciseWorkspace({
  block,
  languageLabel,
  language,
  indentUnit,
  synced,
  brief,
  onSave,
  onClose
}: {
  block: ExerciseBlock
  languageLabel: string
  language: string
  indentUnit: string
  /** The synced code as last loaded; newer code from the app replaces an unchanged buffer. */
  synced: LearningField | undefined
  brief: ReactNode
  /** Saves and resolves with the operation it was saved as, or null if it was refused. */
  onSave: (code: string) => Promise<string | null>
  onClose: () => void
}) {
  const starter = block.starter_code ?? ''
  const initial = typeof synced?.value === 'string' ? synced.value : starter
  const buffer = useRef(initial)
  const [revision, setRevision] = useState(0)
  const [save, setSave] = useState<SaveState>('saved')
  // A share of the row rather than a width, so opening the chat narrows the
  // brief and the editor together.
  const [briefShare, setBriefShare] = useState(0.38)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef(false)
  const own = useRef(new Set<string>(synced ? [synced.operation] : []))
  const row = useRef<HTMLDivElement>(null)

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    if (!pending.current) return
    pending.current = false
    const code = buffer.current
    if (code.length > MAX_EXERCISE_CODE) {
      setSave('too-large')
      return
    }
    setSave('saving')
    const operation = await onSave(code)
    if (operation) own.current.add(operation)
    // A newer edit made while this one was on its way is still waiting.
    setSave(pending.current ? 'unsaved' : operation ? 'saved' : 'failed')
  }, [onSave])

  const change = useCallback(
    (value: string) => {
      buffer.current = value
      pending.current = true
      setSave('unsaved')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS)
    },
    [flush]
  )

  // Leaving the workspace saves what was typed since the last autosave.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => void flushRef.current(), [])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Code saved in the app arrives with the page's periodic refresh. Take it
  // when nothing typed here is waiting; otherwise the next save here wins.
  useEffect(() => {
    if (!synced || typeof synced.value !== 'string' || own.current.has(synced.operation)) return
    own.current.add(synced.operation)
    if (pending.current || synced.value === buffer.current) return
    buffer.current = synced.value
    setRevision((n) => n + 1)
  }, [synced])

  function reset() {
    if (!window.confirm('Replace your code with the original starter? This cannot be undone.')) return
    buffer.current = starter
    setRevision((n) => n + 1)
    pending.current = true
    void flush()
  }

  // Between the brief and the editor. The brief is sized as a share of the row
  // and the editor takes what is left; the editor keeps its floor while dragging.
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const element = row.current
    if (!element) return
    const move = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      const room = Math.max(MIN_BRIEF, rect.width - MIN_EDITOR)
      setBriefShare(Math.max(MIN_BRIEF, Math.min(room, e.clientX - rect.left)) / rect.width)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="web-workbench" ref={row}>
      <section className="workbench-brief" style={{ width: `${briefShare * 100}%` }} aria-label="Exercise">
        <div className="workbench-brief-content">
          <button className="oc-btn secondary workbench-back" onClick={onClose}>
            <ArrowLeft /> Back to lesson
          </button>
          {brief}
        </div>
      </section>
      <div
        className="workbench-grip"
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
      />
      <div className="workbench-main">
        <div className="workbench-head">
          <strong title={block.title}>{block.title}</strong>
          <span className="workbench-lang">{languageLabel}</span>
          <span className={`save-state ${save}`} role="status" aria-label="Code saving status">
            {
              {
                saved: 'Saved',
                unsaved: 'Unsaved',
                saving: 'Saving…',
                failed: 'Not saved',
                'too-large': 'Too long to save'
              }[save]
            }
          </span>
        </div>
        <div className="workbench-editor">
          <Suspense fallback={null}>
            <CodeEditor
              docKey={`${block.id}#${revision}`}
              language={language}
              indentUnit={indentUnit}
              initialDoc={buffer.current}
              onChange={change}
              onSave={() => void flush()}
            />
          </Suspense>
        </div>
        <div className="workbench-actions">
          <button className="oc-btn secondary" onClick={reset}>
            <RotateCcw /> Reset
          </button>
        </div>
        <div className="workbench-app-only">
          <span className="app-required-icon">
            <Monitor />
          </span>
          <p>
            Running the checks and the terminal happen in the desktop app. Your code is saved, so the app opens on it.
          </p>
          <a className="oc-btn secondary" href={server.appUrl}>
            Download the app
          </a>
        </div>
      </div>
    </div>
  )
}
