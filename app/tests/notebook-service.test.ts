// @vitest-environment node
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { CellExecution } from '../src/core/notebook/types'
import type { CourseManifest } from '../src/core/types'
const fake = vi.hoisted(() => ({ ensure: vi.fn<(...args: unknown[]) => Promise<void>>(), runs: [] as { code: string; finish: () => void }[], stopped: 0, created: 0 }))
const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-service-'))
let dataDir = root
vi.mock('electron', () => ({ app: { getPath: () => dataDir, getAppPath: () => resolve(__dirname, '..'), isPackaged: false, on: () => {} } }))
vi.mock('../src/main/notebook-runtime', () => ({
  provisionNotebookEnv: fake.ensure,
  PythonCellWorker: class {
    generation = randomUUID(); stopped = false; busy = false; finish?: () => void
    constructor(_python: string, _path: string, _cwd: string, _env: string, private onClosed: () => void = () => {}) { fake.created++ }
    execute(code: string, _filename: string, notify: (run: CellExecution) => void): Promise<CellExecution> {
      this.busy = true
      const run: CellExecution = { code, generation: this.generation, runId: randomUUID(), count: 1, status: 'running', outputs: [], at: new Date().toISOString() }
      notify(run)
      return new Promise(resolve => {
        this.finish = () => { run.status = this.stopped ? 'stopped' : 'complete'; this.busy = false; notify(run); resolve(run) }
        fake.runs.push({ code, finish: () => this.finish?.() })
      })
    }
    async stop(): Promise<void> { this.stopped = true; fake.stopped++; this.finish?.(); this.onClosed() }
  }
}))
const { createUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { installCourseFixture } = await import('./helpers/course')
const { ensureNotebook, watchNotebook, getNotebook, saveNotebook, runCell, stopNotebook, stopAllNotebooks, stopCourseNotebooks, notebookDirectory, notebookChatContext, rebuildNotebook } = await import('../src/main/notebooks')
const { insertChat, appendMessage, selectChat, selectMessages } = await import('../src/main/chatdb')
const manifest = (): CourseManifest => ({ schema_version: '1.7', version: '0.1.0', slug: 'cells', title: 'Cells', notebook: { cells: [{ content: 'answer = 42' }] }, modules: [{ slug: 'm', title: 'M', lessons: [{ slug: 'l', title: 'L', blocks: [{ type: 'python-cell', slug: 'c', content: '1+1' }] }] }] })
let n = 0
beforeEach(async () => { await stopAllNotebooks(); closeDb(); dataDir = join(root, String(++n)); createUser('Learner'); fake.ensure.mockReset().mockResolvedValue(); fake.runs.length = 0; fake.stopped = 0; fake.created = 0 })
afterAll(async () => { await stopAllNotebooks(); closeDb(); rmSync(root, { recursive: true, force: true }) })
function sender(): WebContents { return Object.assign(new EventEmitter(), { id: n, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents }
describe('course notebook service', () => {
  it('does not initialize on status checks and shares concurrent setup with retryable failure', async () => {
    const course = installCourseFixture(manifest()), win = sender()
    expect(watchNotebook(win, course.courseId)).toMatchObject({ enabled: true, stage: 'idle' })
    expect(fake.ensure).not.toHaveBeenCalled()
    let finish!: () => void
    fake.ensure.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const first = ensureNotebook(course.courseId), second = ensureNotebook(course.courseId)
    expect(fake.ensure).toHaveBeenCalledOnce(); finish(); await Promise.all([first, second])
    expect(watchNotebook(win, course.courseId).stage).toBe('ready')
    await stopCourseNotebooks((await import('../src/main/users')).requireUser(), course.courseId)
    fake.ensure.mockRejectedValueOnce(new Error('disk failure'))
    expect(await ensureNotebook(course.courseId)).toMatchObject({ stage: 'failed', message: 'disk failure' })
    expect(await ensureNotebook(course.courseId, true)).toMatchObject({ stage: 'ready' })
  })
  it('runs saved notebook code, rejects concurrent runs and preserves results on Stop', async () => {
    const course = installCourseFixture(manifest()), win = sender(); watchNotebook(win, course.courseId); await ensureNotebook(course.courseId)
    const cell = getNotebook(course.courseId).cells[0]!, target = { courseId: course.courseId, cellId: cell.id, requestId: randomUUID(), kind: 'notebook' as const }
    const pending = runCell(win, target, 'untrusted override')
    expect(fake.runs[0]!.code).toBe('answer = 42')
    await expect(runCell(win, target)).rejects.toThrow('busy')
    await stopNotebook(course.courseId)
    expect((await pending).status).toBe('stopped')
    expect(getNotebook(course.courseId).cells[0]!.execution?.status).toBe('stopped')
    expect(win.send).toHaveBeenCalledWith('notebook:event', expect.objectContaining({ type: 'execution' }))
  })
  it('validates lesson membership and gives each run a new process', async () => {
    const course = installCourseFixture(manifest()), win = sender(); await ensureNotebook(course.courseId)
    await expect(runCell(win, { courseId: course.courseId, cellId: randomUUID(), requestId: randomUUID(), kind: 'lesson' }, 'code')).rejects.toThrow('not in this course')
    const module = course.modules[0]!; if (module.type === 'project') throw new Error('Expected lesson')
    const target = { courseId: course.courseId, cellId: module.lessons[0]!.blocks[0]!.nodeId!, requestId: randomUUID(), kind: 'lesson' as const }
    const first = runCell(win, target, 'value = 42'); fake.runs[0]!.finish(); const one = await first
    const second = runCell(win, target, 'value'); fake.runs[1]!.finish(); const two = await second
    expect(one.generation).not.toBe(two.generation); expect(fake.stopped).toBe(2)
    expect(getNotebook(course.courseId).cells[0]!.execution).toBeUndefined()
  })
  it('keeps deleted templates empty and retains notebook access after course content removal', async () => {
    const course = installCourseFixture(manifest()), win = sender(); await ensureNotebook(course.courseId)
    const initial = getNotebook(course.courseId); expect(saveNotebook(course.courseId, initial.revision, []).ok).toBe(true)
    const owner = (await import('../src/main/users')).requireUser(); await stopCourseNotebooks(owner, course.courseId)
    const changed = manifest(); delete changed.notebook
    if (changed.modules[0]!.type !== 'project') changed.modules[0]!.lessons[0]!.blocks = [{ type: 'markdown', slug: 'text', content: 'new text' }]
    installCourseFixture(changed, course.courseId)
    expect(watchNotebook(win, course.courseId).enabled).toBe(true); await ensureNotebook(course.courseId)
    expect(getNotebook(course.courseId).cells).toEqual([])
  })
  it('backs up the environment on explicit rebuild and does not replace corrupt notebook state', async () => {
    const course = installCourseFixture(manifest()); await ensureNotebook(course.courseId)
    const owner = (await import('../src/main/users')).requireUser(), dir = notebookDirectory(owner, course.courseId)
    mkdirSync(join(dir, '.venv')); writeFileSync(join(dir, '.venv', 'packages-marker'), 'keep')
    await rebuildNotebook(course.courseId)
    const files = (await import('node:fs')).readdirSync(dir), backup = files.find(file => file.startsWith('.venv.recovery-'))!
    expect(readFileSync(join(dir, backup, 'packages-marker'), 'utf8')).toBe('keep')
    await stopCourseNotebooks(owner, course.courseId); writeFileSync(join(dir, 'notebook.json'), 'broken')
    expect((await ensureNotebook(course.courseId)).stage).toBe('failed'); expect(readFileSync(join(dir, 'notebook.json'), 'utf8')).toBe('broken')
  })
  it('stops work before a user switch and keeps user workspaces separate', async () => {
    const course = installCourseFixture(manifest()), win = sender(); watchNotebook(win, course.courseId); await ensureNotebook(course.courseId)
    const owner = (await import('../src/main/users')).requireUser(), cell = getNotebook(course.courseId).cells[0]!
    const pending = runCell(win, { courseId: course.courseId, cellId: cell.id, requestId: randomUUID(), kind: 'notebook' })
    await stopAllNotebooks(); expect((await pending).status).toBe('stopped')
    const other = createUser('Other'); installCourseFixture(manifest(), course.courseId); await ensureNotebook(course.courseId)
    expect(notebookDirectory(owner, course.courseId)).not.toBe(notebookDirectory(other.id, course.courseId))
    expect(existsSync(join(notebookDirectory(owner, course.courseId), 'notebook.json'))).toBe(true)
    expect(getNotebook(course.courseId).cells[0]!.execution).toBeUndefined()
  })
  it('persists notebook chat sources and quotes without fake lesson identities', async () => {
    const course = installCourseFixture(manifest()); await ensureNotebook(course.courseId)
    insertChat({ id: 'chat', courseId: course.courseId, model: 'gpt-5-mini', startedIn: null, startedInNotebook: true, at: '' })
    appendMessage('chat', { role: 'context', text: notebookChatContext(course.courseId), notebook: true, at: '' })
    appendMessage('chat', { role: 'user', text: 'Explain', notebook: true, quote: { text: 'answer = 42', from: 'notebook', notebook: { cellId: getNotebook(course.courseId).cells[0]!.id } }, at: '' })
    expect(selectChat('chat')).toMatchObject({ startedIn: null, startedInNotebook: true })
    expect(selectMessages('chat')[1]).toMatchObject({ notebook: true, quote: { from: 'notebook', notebook: { cellId: expect.any(String) } } })
    expect(selectMessages('chat')[1]!.lesson).toBeUndefined()
  })
  it('stops active work when its renderer reloads and keeps interrupted results', async () => {
    const course = installCourseFixture(manifest()), win = sender(); watchNotebook(win, course.courseId); await ensureNotebook(course.courseId)
    const cell = getNotebook(course.courseId).cells[0]!
    const pending = runCell(win, { courseId: course.courseId, cellId: cell.id, kind: 'notebook', requestId: randomUUID() })
    win.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(fake.stopped).toBe(0)
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect((await pending).status).toBe('stopped')
    expect(getNotebook(course.courseId).cells[0]!.execution?.status).toBe('stopped')
  })
  it('rejects runs during Restart and prevents shutdown from starting a replacement worker', async () => {
    const course = installCourseFixture(manifest()), win = sender(); await ensureNotebook(course.courseId)
    const cell = getNotebook(course.courseId).cells[0]!, target = { courseId: course.courseId, cellId: cell.id, kind: 'notebook' as const, requestId: randomUUID() }
    const pending = runCell(win, target), restarting = stopNotebook(course.courseId, true)
    const rejected = runCell(win, { ...target, requestId: randomUUID() }), shutdown = stopAllNotebooks()
    await expect(rejected).rejects.toThrow('stopping')
    await Promise.all([shutdown, restarting, pending])
    expect(fake.created).toBe(1)
  })
})
