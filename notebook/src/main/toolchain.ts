/**
 * Finding a language's tool, preparing its environment, and running the checks.
 *
 * The planning half lives in src/core/toolchains/; everything here touches the
 * filesystem or spawns processes. Python exercises always use the bundled runtime.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync, closeSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { childEnv } from '../core/runner'
import { compareOutput } from '../core/toolchains'
import { BUNDLED_PYTHON_ID, BUNDLED_PYTHON_VERSION, bundledPythonDir, bundledPythonPath } from './bundled-python'
import type { RunStep, Toolchain, VersionFloor } from '../core/toolchains/types'
import type { EnvProgress, EnvResult, RunOutcome } from '../core/types'

// macOS may verify a freshly installed signed runtime on its first execution.
const PROBE_TIMEOUT_MS = 15_000
const LOGIN_PATH_TIMEOUT_MS = 4_000
const CREATE_TIMEOUT_MS = 180_000
const INSTALL_TIMEOUT_MS = 300_000
const LOCK_STALE_MS = 10 * 60_000
const DEFAULT_RUN_TIMEOUT_MS = 120_000

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; input?: string; signal?: AbortSignal }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env ?? childEnv({ base: process.env, extra: { PYTHONHOME: null, PYTHONPATH: null, VIRTUAL_ENV: null, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } }), timeout: opts.timeout, signal: opts.signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const timedOut = Boolean(err && (err as { killed?: boolean }).killed)
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut })
      }
    )
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.input)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* PATH                                                                        */
/* -------------------------------------------------------------------------- */

let loginPathPromise: Promise<string> | null = null

/**
 * A Finder-launched app inherits launchd's minimal PATH, so Homebrew and pyenv
 * are invisible - while every terminal the user opens has them, which is why
 * "it works in my shell" is the report this produces. Ask the user's own shell
 * once.
 */
export function resolveLoginPath(): Promise<string> {
  if (loginPathPromise) return loginPathPromise
  loginPathPromise = (async () => {
    const shell = process.env['SHELL'] || '/bin/zsh'
    try {
      const res = await run(shell, ['-lic', 'echo "__OPENCOURSE_PATH__:$PATH"'], { timeout: LOGIN_PATH_TIMEOUT_MS })
      const match = /__OPENCOURSE_PATH__:(.*)/.exec(res.stdout)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch {
      /* fall through to the inherited PATH */
    }
    return process.env['PATH'] ?? ''
  })()
  return loginPathPromise
}

export interface FoundTool {
  path: string
  version: string
}

/** Only the bundled interpreter is eligible, regardless of PATH or installed tools. */
export async function findTool(
  toolchain: Toolchain,
  floor: VersionFloor
): Promise<{ found?: FoundTool; tried: string[]; message?: string }> {
  const path = bundledPythonPath()
  const tried = [path]
  if (toolchain.id !== 'python') return { tried, message: 'Only Python exercises are supported.' }
  const version = await run(path, toolchain.discovery.versionArgs, { timeout: PROBE_TIMEOUT_MS })
  if (version.code !== 0 || version.stdout.trim() !== BUNDLED_PYTHON_VERSION) {
    return { tried, message: 'The bundled Python runtime is missing or damaged. Reinstall OpenCourse.' }
  }
  const probe = await run(path, toolchain.discovery.probeArgs(floor), { timeout: PROBE_TIMEOUT_MS })
  if (probe.code !== 0) return { tried, message: `This exercise requires Python ${floor.label} or newer; OpenCourse bundles Python ${BUNDLED_PYTHON_VERSION}. Update OpenCourse.` }
  return { tried, found: { path, version: version.stdout.trim() } }
}

/* -------------------------------------------------------------------------- */
/* the course environment                                                      */
/* -------------------------------------------------------------------------- */

function noTool(toolchain: Toolchain, floor: VersionFloor, tried: string[], message?: string): EnvResult {
  return {
    ok: false,
    code: 'no-tool',
    language: toolchain.id,
    floorLabel: floor.label,
    tried,
    hint: toolchain.installHint(floor),
    message: message ?? `This exercise requires Python ${floor.label} or newer; OpenCourse bundles Python ${BUNDLED_PYTHON_VERSION}. Update OpenCourse.`
  }
}

const RUNTIME_STAMP = '.opencourse-runtime.json'
function runtimeStamp(): string {
  return JSON.stringify({ identity: BUNDLED_PYTHON_ID, location: bundledPythonDir() })
}

/** Check provenance as well as liveness: a working system-created venv is not eligible. */
async function envIsHealthy(toolchain: Toolchain, envDir: string, signal?: AbortSignal): Promise<boolean> {
  const exe = toolchain.provision!.exe(envDir)
  if (!existsSync(exe)) return false
  const health = await run(exe, ['-c', 'import sys, os, json; print(json.dumps([os.path.realpath(sys.base_prefix), "%d.%d.%d" % sys.version_info[:3]]))'], { timeout: PROBE_TIMEOUT_MS, signal })
  try {
    const [base, version] = JSON.parse(health.stdout) as string[]
    const expected = await run(bundledPythonPath(), ['-c', 'import sys, os; print(os.path.realpath(sys.prefix))'], { timeout: PROBE_TIMEOUT_MS, signal })
    return health.code === 0 && expected.code === 0 && base === expected.stdout.trim() && version === BUNDLED_PYTHON_VERSION
  } catch { return false }
}

function acquireLock(courseDir: string): (() => void) | null {
  const lockPath = join(courseDir, '.opencourse', 'env.lock')
  mkdirSync(join(courseDir, '.opencourse'), { recursive: true })
  try {
    const fd = openSync(lockPath, 'wx')
    writeFileSync(lockPath, String(process.pid))
    closeSync(fd)
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return null
      unlinkSync(lockPath)
      const fd = openSync(lockPath, 'wx')
      closeSync(fd)
    } catch {
      return null
    }
  }
  return () => {
    try {
      unlinkSync(lockPath)
    } catch {
      /* already gone */
    }
  }
}

const inFlight = new Map<string, Promise<EnvResult>>()
const envControllers = new Map<string, AbortController>()
const envRequests = new Map<string, string>()

export interface EnsureEnvOptions {
  toolchain: Toolchain
  courseDir: string
  /** Absent for a toolchain with nothing to install. */
  envDir?: string
  floor: VersionFloor
  /** Contents of the deps file, already written to disk. */
  deps?: string
  depsPath?: string
  onProgress?: (progress: EnvProgress) => void
}

/**
 * Idempotent, and shared per environment: two clicks must not start two builds
 * against the same folder.
 */
export function ensureCourseEnv(options: EnsureEnvOptions): Promise<EnvResult> {
  const { toolchain, envDir, floor } = options
  if (toolchain.id !== 'python') return Promise.resolve({ ok: false, code: 'failed', message: 'Only Python exercises are supported.' })
  if (!envDir || !toolchain.provision) return Promise.resolve({ ok: false, code: 'failed', message: 'Python exercises require a local course environment.' })
  // Validate every caller before sharing a setup: a higher exercise minimum cannot reuse a lower one.
  const [major, minor, patch] = BUNDLED_PYTHON_VERSION.split('.').map(Number)
  if (floor.kind !== 'semver' || major! < floor.major || (major === floor.major && (minor! < floor.minor || (minor === floor.minor && patch! < (floor.patch ?? 0))))) {
    return Promise.resolve(noTool(toolchain, floor, [bundledPythonPath()]))
  }
  const request = JSON.stringify([floor.label, options.deps, options.depsPath, bundledPythonDir()])
  const existing = inFlight.get(envDir)
  if (existing) {
    if (envRequests.get(envDir) === request) return existing
    return existing.then(() => ensureCourseEnv(options))
  }
  envRequests.set(envDir, request)
  const controller = new AbortController()
  envControllers.set(envDir, controller)
  const task = provisionEnv(options, envDir, controller.signal).finally(() => {
    inFlight.delete(envDir)
    envControllers.delete(envDir)
    envRequests.delete(envDir)
  })
  inFlight.set(envDir, task)
  return task
}

async function provisionEnv(options: EnsureEnvOptions, envDir: string, signal: AbortSignal): Promise<EnvResult> {
  const { toolchain, courseDir, floor, deps, depsPath, onProgress } = options
  const provision = toolchain.provision
  if (!provision) throw new Error('provisionEnv without a provision spec')
  const notify = (stage: EnvProgress['stage'], message: string): void => onProgress?.({ stage, message })

  const release = acquireLock(courseDir)
  if (!release) {
    return { ok: false, code: 'failed', message: 'Another OpenCourse window is setting this course up. Try again in a moment.' }
  }

  try {
    notify('looking', 'Checking bundled Python…')
    const { found, tried, message } = await findTool(toolchain, floor)
    signal.throwIfAborted()
    if (!found) return noTool(toolchain, floor, tried, message)
    const stamp = join(envDir, RUNTIME_STAMP)
    const matches = existsSync(stamp) && readFileSync(stamp, 'utf8') === runtimeStamp()
    let healthy = matches && await envIsHealthy(toolchain, envDir, signal)
    signal.throwIfAborted()

    if (!healthy) {
      notify('creating', `Setting up the course environment with ${toolchain.label} ${found.version}…`)
      const created = await run(found.path, provision.create(envDir), { timeout: CREATE_TIMEOUT_MS, signal })
      signal.throwIfAborted()
      if (created.code !== 0) {
        return {
          ok: false,
          code: 'failed',
          message: 'Could not create the course environment.',
          detail: created.stderr || created.stdout
        }
      }
      healthy = await envIsHealthy(toolchain, envDir, signal)
      signal.throwIfAborted()
      if (!healthy) {
        return { ok: false, code: 'failed', message: 'The course environment was created but does not run.' }
      }
      writeFileSync(stamp, runtimeStamp())
    }

    const exe = provision.exe(envDir)
    const stampPath = join(envDir, provision.stampFile)
    const stamped = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null

    if (depsPath && deps !== undefined && stamped !== deps) {
      notify('installing', 'Installing the test requirements…')
      const env = childEnv({
        base: process.env,
        pathDirs: [provision.binDir(envDir)],
        extra: toolchain.extraEnv({ envDir })
      })
      signal.throwIfAborted()
      const installed = await run(exe, provision.install(depsPath), { env, timeout: INSTALL_TIMEOUT_MS, signal })
      signal.throwIfAborted()
      if (installed.code !== 0) {
        return {
          ok: false,
          code: 'failed',
          message: 'Could not install the test requirements - are you online?',
          detail: installed.stderr || installed.stdout
        }
      }
      writeFileSync(stampPath, deps)
    }

    // A cold first import inside a fresh environment can add enough latency to
    // trip the loose wall-clock assertions the course format asks exercises to use.
    if (provision.warm) {
      notify('warming', 'Warming up…')
      const warmed = await run(exe, provision.warm, { timeout: PROBE_TIMEOUT_MS * 4, signal })
      if (warmed.code !== 0) {
        if (existsSync(stampPath)) unlinkSync(stampPath)
        return { ok: false, code: 'failed', message: 'The course test requirements do not run. Retry setup.', detail: warmed.stderr || warmed.stdout }
      }
      signal.throwIfAborted()
    }

    const version = await run(exe, toolchain.discovery.versionArgs, { timeout: PROBE_TIMEOUT_MS, signal })
    signal.throwIfAborted()
    if (version.code !== 0) return { ok: false, code: 'failed', message: 'The course interpreter does not run. Retry setup.' }
    notify('ready', `Ready · Python ${found.version}`)
    return { ok: true, envDir, tool: exe, toolVersion: (version.stdout.trim().split('\n')[0] ?? '').trim() }
  } catch (err) {
    if (signal.aborted) return { ok: false, code: 'failed', message: 'Course environment setup was cancelled.' }
    throw err
  } finally {
    release()
  }
}

/* -------------------------------------------------------------------------- */
/* running the checks                                                          */
/* -------------------------------------------------------------------------- */

export interface RunStepsOptions {
  toolchain: Toolchain
  steps: RunStep[]
  cwd: string
  envDir?: string
  onData: (chunk: string) => void
  timeoutMs?: number
  /** Width of the pane the output lands in, so a reporter wraps where it wraps. */
  cols?: number
}

/** One run in flight per renderer. Its own object, so a cancel cannot leak. */
interface ActiveRun {
  child: ChildProcess | null
  cancelled: boolean
  cwd: string
  finished: Promise<void>
}

const active = new Map<number, ActiveRun>()

/** xterm needs CRLF; a bare LF leaves the cursor in the old column. */
function crlf(value: string): string {
  return value.replace(/(?<!\r)\n/g, '\r\n')
}

interface StepResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
}

function runStep(
  run_: ActiveRun,
  step: RunStep,
  options: RunStepsOptions,
  env: Record<string, string>,
  capture: boolean
): Promise<StepResult> {
  return new Promise((resolve) => {
    const [file, ...args] = step.argv
    if (!file) {
      resolve({ exitCode: 1, timedOut: false, stdout: '' })
      return
    }

    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env,
        stdio: [step.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      options.onData(`\r\ncould not start ${step.label}: ${(err as Error).message}\r\n`)
      resolve({ exitCode: 1, timedOut: false, stdout: '' })
      return
    }

    run_.child = child
    let timedOut = false
    let stdout = ''

    if (step.stdin !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(step.stdin)
    }

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      if (capture) stdout += text
      options.onData(crlf(text))
    })
    child.stderr?.on('data', (buf: Buffer) => options.onData(crlf(buf.toString('utf8'))))

    const hardStop = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3_000)
    }, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)

    child.on('error', (err) => options.onData(`\r\n${err.message}\r\n`))

    // 'close', not 'exit': the pipes must drain or the tail of a failure report
    // goes missing.
    child.on('close', (code) => {
      clearTimeout(hardStop)
      if (run_.child === child) run_.child = null
      resolve({ exitCode: code, timedOut, stdout })
    })
  })
}

/**
 * Runs a plan's steps in order, stopping at the first failure, and streams
 * combined output. A stale artifact from the previous edit can make a broken
 * exercise look like it passes, and a false pass writes progress - so the
 * toolchain's list of them is wiped first.
 */
export async function runSteps(key: number, options: RunStepsOptions): Promise<RunOutcome> {
  cancelRun(key)
  let finish!: () => void
  const finished = new Promise<void>((done) => { finish = done })
  const self: ActiveRun = { child: null, cancelled: false, cwd: options.cwd, finished }
  active.set(key, self)

  try {
    const { layout } = options.toolchain
    for (const artifact of layout.staleArtifacts) {
      rmSync(join(options.cwd, artifact), { recursive: true, force: true })
    }
    if (layout.buildDirName) mkdirSync(join(options.cwd, layout.buildDirName), { recursive: true })

    const env = childEnv({
      base: process.env,
      pathDirs: [
        ...(options.envDir && options.toolchain.provision
          ? [options.toolchain.provision.binDir(options.envDir)]
          : [])
      ],
      extra: {
        ...options.toolchain.extraEnv({ envDir: options.envDir }),
        COLUMNS: String(Math.max(40, options.cols ?? 80))
      }
    })

    const labelled = options.steps.length > 1

    for (const step of options.steps) {
      if (self.cancelled) return { exitCode: null, timedOut: false, cancelled: true }
      if (labelled) options.onData(`\x1b[2m${step.label}\x1b[0m\r\n`)

      const result = await runStep(self, step, options, env, step.expect !== undefined)
      if (self.cancelled) return { exitCode: null, timedOut: false, cancelled: true }
      if (result.timedOut) return { exitCode: result.exitCode, timedOut: true, cancelled: false, failedStep: step.label }
      if (result.exitCode !== 0) {
        return { exitCode: result.exitCode, timedOut: false, cancelled: false, failedStep: step.label }
      }
      if (step.expect) {
        const verdict = compareOutput(result.stdout, step.expect)
        if (!verdict.ok) {
          options.onData(`\r\n${crlf(verdict.report)}\r\n`)
          return { exitCode: 1, timedOut: false, cancelled: false, failedStep: step.label }
        }
      }
    }

    return { exitCode: 0, timedOut: false, cancelled: false }
  } finally {
    if (active.get(key) === self) active.delete(key)
    finish()
  }
}

export function cancelRun(key: number): void {
  const self = active.get(key)
  if (!self || self.cancelled) return
  self.cancelled = true
  const child = self.child
  if (!child) return
  child.kill('SIGTERM')
  setTimeout(() => {
    if (self.child === child) child.kill('SIGKILL')
  }, 2_000)
}

export function disposeRuns(): void {
  for (const key of [...active.keys()]) cancelRun(key)
}

/** Stop writers before deleting a course workspace; wait for their processes to exit. */
export async function stopCourseWork(courseDir: string): Promise<void> {
  const root = resolve(courseDir)
  const belongs = (path: string): boolean => resolve(path) === root || resolve(path).startsWith(root + sep)
  const pending: Promise<unknown>[] = []
  for (const [envDir, controller] of envControllers) {
    if (!belongs(envDir)) continue
    controller.abort()
    const task = inFlight.get(envDir)
    if (task) pending.push(task)
  }
  for (const [key, run] of active) {
    if (!belongs(run.cwd)) continue
    cancelRun(key)
    pending.push(run.finished)
  }
  await Promise.allSettled(pending)
}
