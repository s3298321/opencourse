/** Python provisioning and subprocess control; no Electron dependency. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Writable, Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { childEnv } from '../core/runner'
import { venvBinDir, venvPython } from '../core/toolchains/python'
import { MAX_OUTPUT_BYTES, type CellExecution } from '../core/notebook/types'

export function notebookProcessEnv(envDir: string): Record<string, string> {
  return childEnv({ base: process.env, pathDirs: [venvBinDir(envDir)], extra: { PYTHONHOME: null, PYTHONPATH: null, PYTHONNOUSERSITE: '1', VIRTUAL_ENV: envDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } })
}
function probe(file: string, args: string[], signal: AbortSignal, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { signal, timeout, env: childEnv({ base: process.env, extra: { PYTHONHOME: null, PYTHONPATH: null, PYTHONNOUSERSITE: '1' } }), maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(stdout.trim())))
}
export async function provisionNotebookEnv(envDir: string, python: string, version: string, signal: AbortSignal): Promise<void> {
  mkdirSync(join(envDir, '..'), { recursive: true })
  const lock = `${envDir}.lock`
  const acquire = (): void => { const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd) }
  try { acquire() } catch {
    try { const pid = Number(readFileSync(lock, 'utf8')); if (!pid) throw new Error('Invalid setup lock.'); process.kill(pid, 0); throw new Error('Another window is preparing this notebook. Retry after it finishes.') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; unlinkSync(lock); acquire() }
  }
  try {
    const bundled = JSON.parse(await probe(python, ['-c', 'import sys,os,json,venv,ensurepip; print(json.dumps(["%d.%d.%d" % sys.version_info[:3], os.path.realpath(sys.prefix)]))'], signal)) as string[]
    if (bundled[0] !== version) throw new Error('The bundled Python runtime is missing or damaged. Reinstall OpenCourse.')
    const stampPath = join(envDir, '.opencourse-notebook-runtime.json')
    let stamp: { version: string; base: string; provisioned?: boolean } | undefined
    if (existsSync(envDir)) {
      try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')) } catch { throw new Error('This notebook environment has no valid runtime record. Rebuild it with a recovery backup.') }
      if (typeof stamp?.version !== 'string' || typeof stamp.base !== 'string') throw new Error('This notebook environment has no valid runtime record. Rebuild it with a recovery backup.')
      if (stamp.version.split('.').slice(0, 2).join('.') !== version.split('.').slice(0, 2).join('.')) throw new Error('The notebook uses a different Python version. Rebuild it with a recovery backup, then reinstall your packages.')
    } else {
      mkdirSync(envDir)
      writeFileSync(stampPath, JSON.stringify({ version, base: bundled[1], provisioned: false }))
    }
    let healthy = false
    try {
      const health = JSON.parse(await probe(venvPython(envDir), ['-c', 'import sys,os,json,pip; print(json.dumps(["%d.%d.%d" % sys.version_info[:3], os.path.realpath(sys.base_prefix), sys.prefix != sys.base_prefix, os.path.realpath(sys.prefix)]))'], signal)) as unknown[]
      healthy = health[0] === version && health[1] === bundled[1] && health[2] === true && health[3] === realpathSync(envDir)
    } catch { signal.throwIfAborted() }
    if (!healthy) {
      if (stamp && stamp.provisioned !== false && stamp.base === bundled[1] && stamp.version === version) throw new Error('This notebook environment is damaged. Rebuild it with a recovery backup, then reinstall your packages.')
      // venv --upgrade leaves existing interpreter symlinks untouched. Replace
      // only those app-owned links so a moved app cannot retain its old binary.
      for (const name of ['python', 'python3', `python${version.split('.').slice(0, 2).join('.')}`]) {
        const link = join(venvBinDir(envDir), name)
        if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link)
      }
      // No --clear and no --upgrade-deps: keep site-packages, and never access the network.
      await probe(python, ['-m', 'venv', ...(stamp ? ['--upgrade'] : []), envDir], signal, 180_000)
      const health = JSON.parse(await probe(venvPython(envDir), ['-c', 'import sys,os,json,pip; print(json.dumps(["%d.%d.%d" % sys.version_info[:3], os.path.realpath(sys.base_prefix), sys.prefix != sys.base_prefix, os.path.realpath(sys.prefix)]))'], signal)) as unknown[]
      if (health[0] !== version || health[1] !== bundled[1] || health[2] !== true || health[3] !== realpathSync(envDir)) throw new Error('The notebook interpreter could not be repaired. Rebuild it with a recovery backup.')
    }
    signal.throwIfAborted()
    writeFileSync(stampPath, JSON.stringify({ version, base: bundled[1], provisioned: true }))
  } finally { unlinkSync(lock) }
}

export class PythonCellWorker {
  readonly generation = randomUUID()
  private child: ChildProcess
  private ready: Promise<void>
  private closed: Promise<void>
  private closing = false
  private count = 0
  private active?: { execution: CellExecution; bytes: number; notify: (run: CellExecution) => void; resolve: (run: CellExecution) => void; reject: (error: unknown) => void; notificationFailed?: boolean; timer?: ReturnType<typeof setTimeout>; outputTimer?: ReturnType<typeof setTimeout> }
  constructor(python: string, workerPath: string, cwd: string, envDir: string, private onClosed: () => void = () => {}) {
    this.child = spawn(python, ['-u', workerPath], { cwd, env: notebookProcessEnv(envDir), detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    let ready!: () => void, failed!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => { ready = resolve; failed = reject })
    // A start followed immediately by Stop still consumes the rejected readiness promise.
    void this.ready.catch(() => {})
    const startup = setTimeout(() => { failed(new Error('Python worker did not start.')); void this.stop() }, 15_000)
    const lines = createInterface({ input: this.child.stdio[4] as Readable })
    lines.on('line', line => {
      try {
        const event = JSON.parse(line) as { type: string; runId?: string; text?: string; status?: string }
        if (event.type === 'ready') { clearTimeout(startup); ready(); return }
        const active = this.active
        if (!active || event.runId !== active.execution.runId) return
        if (event.type === 'stdout' || event.type === 'stderr') {
          const value = String(event.text ?? '')
          const wasTruncated = active.execution.truncated
          const remaining = MAX_OUTPUT_BYTES - active.bytes
          const buffer = Buffer.from(value)
          // Avoid splitting a UTF-8 code point at the limit.
          let text = buffer.subarray(0, Math.max(0, remaining)).toString('utf8')
          if (buffer.length > remaining) { text = text.replace(/\uFFFD$/, ''); active.execution.truncated = true }
          active.bytes += Buffer.byteLength(text)
          const last = active.execution.outputs.at(-1)
          if (text) { if (last?.kind === event.type) last.text += text; else active.execution.outputs.push({ kind: event.type, text }) }
          if ((text || (!wasTruncated && active.execution.truncated)) && !active.outputTimer) active.outputTimer = setTimeout(() => { active.outputTimer = undefined; if (this.active === active) this.notify(active) }, 50)
        } else if (event.type === 'done') this.finish(event.status === 'complete' ? 'complete' : 'failed')
      } catch { failed(new Error('Invalid Python worker protocol.')); void this.stop() }
    })
    this.closed = new Promise(resolve => {
      this.child.once('close', () => {
        if (this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* descendants already gone */ } }
        clearTimeout(startup); failed(new Error('Python worker exited.'))
        if (this.active) {
          if (!this.closing && this.active.bytes < MAX_OUTPUT_BYTES - 100) this.active.execution.outputs.push({ kind: 'stderr', text: 'Python exited unexpectedly. Restart the kernel to run more cells.\n' })
          this.finish(this.closing ? 'stopped' : 'failed')
        }
        lines.close(); this.onClosed(); resolve()
      })
    })
    this.child.on('error', error => { failed(error) })
  }
  get busy(): boolean { return this.active !== undefined }
  get stopped(): boolean { return this.closing || this.child.exitCode !== null || this.child.signalCode !== null }
  async execute(code: string, filename: string, notify: (run: CellExecution) => void, timeout?: number): Promise<CellExecution> {
    if (this.busy || this.stopped) throw new Error('The Python kernel is busy or stopped.')
    // Reserve before awaiting readiness, so concurrent callers cannot both execute.
    const execution: CellExecution = { runId: randomUUID(), generation: this.generation, count: ++this.count, code, status: 'running', outputs: [], at: new Date().toISOString() }
    const result = new Promise<CellExecution>((resolve, reject) => { this.active = { execution, bytes: 0, notify, resolve, reject } })
    void result.catch(() => {})
    this.notify(this.active!)
    try {
      await this.ready
      if (this.closing || !this.active) return result
      if (timeout) this.active.timer = setTimeout(() => void this.stop(), timeout)
      ;(this.child.stdio[3] as Writable).write(JSON.stringify({ runId: execution.runId, code, filename: `${filename} [${execution.runId}]` }) + '\n', error => { if (error) void this.stop() })
    } catch {
      if (this.active) {
        execution.outputs.push({ kind: 'stderr', text: 'The Python worker could not start or exited unexpectedly. Restart it and try again.\n' })
        this.finish(this.closing ? 'stopped' : 'failed')
      }
    }
    return result
  }
  private finish(status: CellExecution['status']): void {
    const active = this.active
    if (!active) return
    clearTimeout(active.timer); clearTimeout(active.outputTimer); active.execution.status = status; this.active = undefined
    this.notify(active); active.resolve(structuredClone(active.execution))
  }
  private notify(active: NonNullable<PythonCellWorker['active']>): void {
    if (active.notificationFailed) return
    try { active.notify(structuredClone(active.execution)) }
    catch (error) { active.notificationFailed = true; active.reject(error); void this.stop() }
  }
  async stop(): Promise<void> {
    if (this.closing) return this.closed
    this.closing = true
    const pid = this.child.pid
    const kill = (signal: NodeJS.Signals): void => { if (pid) { try { process.kill(-pid, signal) } catch { /* already gone */ } } }
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 1000)
    // close can wait on descendants holding control pipes, so kill the group on exit too.
    await this.closed
    clearTimeout(timer); kill('SIGKILL')
  }
}
