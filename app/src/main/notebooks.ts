import { app, type WebContents } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { declaresNotebook, notebookContextText } from '../core/notebook/context'
import { MAX_CELL_BYTES, type CellTarget, type CellRunRequest, type CellExecution, type NotebookEvent, type NotebookStatus } from '../core/notebook/types'
import { assertSafeSegment } from '../core/scaffold'
import { getCourse } from './courses'
import { requireUser, currentUserId } from './users'
import { userWorkspaceRoot } from './paths'
import { assertCourseAvailable } from './course-busy'
import { bundledPythonPath, BUNDLED_PYTHON_VERSION } from './bundled-python'
import { venvPython } from '../core/toolchains/python'
import { PythonCellWorker, provisionNotebookEnv } from './notebook-runtime'
import { initializeNotebook, readNotebook, recordCellExecution, saveNotebookCells, writeNotebook } from './notebook-store'
import { log } from './log'
import { whenSenderGone } from './senders'

interface Session {
  owner: string; courseId: string; status: NotebookStatus; setup?: Promise<void>; controller?: AbortController
  kernel?: PythonCellWorker; runningCellId?: string; lessonRuns: Map<string, { worker: PythonCellWorker; senderId: number }>
  kernelOperation?: Promise<void>; closing?: boolean
}
const sessions = new Map<string, Session>()
const watchers = new Map<number, { sender: WebContents; owner: string; courses: Set<string>; unwatch: () => void }>()
export function notebookDirectory(owner: string, courseId: string): string { return join(userWorkspaceRoot(owner), assertSafeSegment(courseId, 'course id'), 'notebook') }
function documentPath(owner: string, courseId: string): string { return join(notebookDirectory(owner, courseId), 'notebook.json') }
function workerPath(): string { return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'notebook', 'worker.py') }
function sessionFor(courseId: string): Session {
  assertCourseAvailable(courseId)
  const owner = requireUser(), course = getCourse(courseId)
  if (!course) throw new Error('That course is not in your library.')
  const key = `${owner}/${courseId}`
  let session = sessions.get(key)
  if (!session) { session = { owner, courseId, status: { enabled: declaresNotebook(course) || existsSync(documentPath(owner, courseId)), stage: 'idle', kernel: 'stopped' }, lessonRuns: new Map() }; sessions.set(key, session) }
  session.status.enabled = declaresNotebook(course) || existsSync(documentPath(owner, courseId))
  return session
}
function push(session: Session, event: NotebookEvent): void {
  for (const watch of watchers.values()) if (watch.owner === session.owner && watch.courses.has(session.courseId) && !watch.sender.isDestroyed()) {
    try { watch.sender.send('notebook:event', event) } catch { /* renderer stopped accepting events */ }
  }
}
function statusChanged(session: Session): void { push(session, { type: 'status', courseId: session.courseId, status: { ...session.status } }) }
export function watchNotebook(sender: WebContents, courseId: string): NotebookStatus {
  const session = sessionFor(courseId)
  let watch = watchers.get(sender.id)
  if (!watch) {
    const old = { sender, owner: session.owner, courses: new Set<string>(), unwatch: () => {} }
    watch = old; watchers.set(sender.id, old)
    old.unwatch = whenSenderGone(sender, () => {
      if (watchers.get(sender.id) !== old) return
      watchers.delete(sender.id); old.unwatch()
      for (const session of sessions.values()) if (session.owner === old.owner) {
        for (const [id, run] of session.lessonRuns) if (run.senderId === sender.id) void stopLessonCell({ courseId: session.courseId, cellId: id, kind: 'lesson' }, session)
        if (old.courses.has(session.courseId) && ![...watchers.values()].some(w => w.owner === old.owner && w.courses.has(session.courseId))) void stopSession(session)
      }
    })
  }
  watch.courses.add(courseId)
  return { ...session.status }
}
export async function ensureNotebook(courseId: string, retry = false): Promise<NotebookStatus> {
  const session = sessionFor(courseId)
  if (!session.status.enabled) return { ...session.status }
  if (session.setup) { await session.setup; return { ...session.status } }
  if (session.status.stage === 'ready' || (session.status.stage === 'failed' && !retry)) return { ...session.status }
  session.status.stage = 'creating'; delete session.status.message; statusChanged(session)
  session.controller = new AbortController()
  const controller = session.controller
  session.setup = (async () => {
    try {
      const course = getCourse(courseId)!
      const path = documentPath(session.owner, courseId)
      const document = initializeNotebook(path, course.notebook)
      // Runs cannot resume after process/app shutdown.
      let changed = false
      for (const cell of document.cells) if (cell.execution?.status === 'running') { cell.execution.status = 'stopped'; changed = true }
      if (changed) { document.revision++; writeNotebook(path, document) }
      await provisionNotebookEnv(join(notebookDirectory(session.owner, courseId), '.venv'), bundledPythonPath(), BUNDLED_PYTHON_VERSION, controller.signal)
      controller.signal.throwIfAborted()
      session.status.stage = 'ready'
      push(session, { type: 'document', courseId, document })
    } catch (error) {
      session.status.stage = 'failed'; session.status.message = (error as Error).message
      log.child('notebook', { userId: session.owner }).warn('Notebook setup failed', { courseId, error })
    } finally { session.setup = undefined; session.controller = undefined; statusChanged(session) }
  })()
  await session.setup
  return { ...session.status }
}
export function getNotebook(courseId: string) { const s = sessionFor(courseId); return readNotebook(documentPath(s.owner, courseId)) }
export function saveNotebook(courseId: string, revision: number, cells: { id: string; content: string }[]) {
  const s = sessionFor(courseId)
  if (s.runningCellId && !cells.some(cell => cell.id === s.runningCellId)) throw new Error('Stop the running cell before deleting it.')
  const result = saveNotebookCells(documentPath(s.owner, courseId), revision, cells)
  if (result.ok) push(s, { type: 'document', courseId, document: result.document })
  return result
}
export function clearNotebookOutput(courseId: string, cellId: string) {
  const s = sessionFor(courseId)
  if (s.runningCellId === cellId) throw new Error('Stop this cell before clearing its output.')
  const document = recordCellExecution(documentPath(s.owner, courseId), cellId)
  push(s, { type: 'document', courseId, document }); return document
}
function newKernel(s: Session): PythonCellWorker {
  const root = notebookDirectory(s.owner, s.courseId), env = join(root, '.venv'), cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  s.status.kernel = 'starting'
  const kernel = new PythonCellWorker(venvPython(env), workerPath(), cwd, env, () => {
    if (s.kernel === kernel) { s.kernel = undefined; s.status.kernel = s.kernelOperation ? 'stopping' : 'stopped'; delete s.status.generation; statusChanged(s) }
  })
  s.kernel = kernel; s.status.generation = kernel.generation; statusChanged(s)
  return kernel
}
export async function runCell(sender: WebContents, target: CellRunRequest, source?: string): Promise<CellExecution> {
  if (!target || typeof target.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(target.requestId)) throw new Error('Invalid Python execution request identity.')
  watchNotebook(sender, target.courseId)
  const s = sessionFor(target.courseId)
  if (s.closing || (target.kind === 'notebook' && s.kernelOperation)) throw new Error('The notebook is stopping. Wait before running another cell.')
  if (s.status.stage !== 'ready') throw new Error('The course notebook environment is not ready.')
  if (target.kind !== 'lesson' && target.kind !== 'notebook') throw new Error('Invalid cell target.')
  let code: string, worker: PythonCellWorker
  if (target.kind === 'notebook') {
    if (s.runningCellId) throw new Error('The notebook kernel is busy.')
    const cell = getNotebook(target.courseId).cells.find(cell => cell.id === target.cellId)
    if (!cell) throw new Error('That notebook cell no longer exists.')
    code = cell.content; worker = s.kernel && !s.kernel.stopped ? s.kernel : newKernel(s)
    s.runningCellId = target.cellId; s.status.runningCellId = target.cellId; s.status.kernel = 'busy'; statusChanged(s)
  } else {
    const course = getCourse(target.courseId)!
    const cell = course.modules.flatMap(module => module.type === 'project' ? [] : module.lessons).flatMap(lesson => lesson.blocks).find(block => block.nodeId === target.cellId && block.type === 'python-cell')
    if (!cell) throw new Error('That Python lesson cell is not in this course.')
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_CELL_BYTES) throw new Error('Cell source exceeds the 1 MiB limit.')
    if (s.lessonRuns.has(target.cellId)) throw new Error('This lesson cell is already running.')
    code = source
    const root = notebookDirectory(s.owner, s.courseId), env = join(root, '.venv'), cwd = join(root, 'lesson-cells', assertSafeSegment(target.cellId, 'cell id'))
    mkdirSync(cwd, { recursive: true })
    worker = new PythonCellWorker(venvPython(env), workerPath(), cwd, env)
    s.lessonRuns.set(target.cellId, { worker, senderId: sender.id })
  }
  let lastWrite = 0
  try {
    return await worker.execute(code, `<${target.kind}-cell-${target.cellId}>`, execution => {
      // Captured owner/session: never resolve persistence against a newly switched user.
      if (currentUserId() !== s.owner) return
      if (target.kind === 'notebook' && (execution.status !== 'running' || Date.now() - lastWrite > 300)) {
        lastWrite = Date.now()
        const document = recordCellExecution(documentPath(s.owner, s.courseId), target.cellId, execution)
        push(s, { type: 'document', courseId: s.courseId, document })
      }
      push(s, { type: 'execution', target, execution })
    }, target.kind === 'lesson' ? 120_000 : undefined)
  } finally {
    if (target.kind === 'lesson') { await worker.stop(); s.lessonRuns.delete(target.cellId) }
    else { s.runningCellId = undefined; delete s.status.runningCellId; s.status.kernel = s.kernelOperation ? 'stopping' : s.kernel && !s.kernel.stopped ? 'idle' : 'stopped'; statusChanged(s) }
  }
}
export async function stopNotebook(courseId: string, restart = false): Promise<NotebookStatus> {
  const s = sessionFor(courseId)
  if (s.closing || s.kernelOperation) throw new Error('The notebook is already stopping.')
  s.status.kernel = 'stopping'; statusChanged(s)
  s.kernelOperation = (async () => {
    try { await s.kernel?.stop(); if (restart && !s.closing && s.status.stage === 'ready') newKernel(s) }
    finally { s.kernelOperation = undefined; s.status.kernel = s.kernel && !s.kernel.stopped ? 'idle' : 'stopped'; statusChanged(s) }
  })()
  await s.kernelOperation
  return { ...s.status }
}
export async function stopLessonCell(target: CellTarget, session?: Session, senderId?: number): Promise<void> {
  const s = session ?? sessionFor(target.courseId)
  const run = s.lessonRuns.get(target.cellId)
  if (run && (senderId === undefined || run.senderId === senderId)) await run.worker.stop()
}
async function stopSession(s: Session): Promise<void> {
  s.closing = true
  s.controller?.abort()
  try { await Promise.allSettled([s.setup, s.kernelOperation, s.kernel?.stop(), ...[...s.lessonRuns.values()].map(run => run.worker.stop())]) }
  finally { s.closing = false }
}
export async function stopCourseNotebooks(owner: string, courseId: string): Promise<void> {
  const key = `${owner}/${courseId}`, s = sessions.get(key)
  if (s) { await stopSession(s); sessions.delete(key) }
}
export async function stopAllNotebooks(): Promise<void> {
  await Promise.allSettled([...sessions.values()].map(stopSession)); sessions.clear()
  for (const watch of watchers.values()) watch.unwatch()
  watchers.clear()
}
export async function rebuildNotebook(courseId: string): Promise<NotebookStatus> {
  const s = sessionFor(courseId)
  await stopSession(s)
  const env = join(notebookDirectory(s.owner, courseId), '.venv')
  if (existsSync(env)) renameSync(env, `${env}.recovery-${Date.now()}`)
  s.status.stage = 'idle'
  return ensureNotebook(courseId, true)
}
export function notebookChatContext(courseId: string): string {
  const s = sessionFor(courseId)
  if (!s.status.enabled) throw new Error('This course has no notebook.')
  return notebookContextText(getCourse(courseId)!, getNotebook(courseId))
}
