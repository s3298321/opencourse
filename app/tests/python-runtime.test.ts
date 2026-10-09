/**
 * Real-Python integration. Creates a virtualenv and runs pytest, so it is slow
 * and opt-in: OPENCOURSE_TEST_PYTHON=1 npx vitest run tests/python-runtime.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { depsFor } from '@core/scaffold'
import { pythonToolchain } from '@core/toolchains'
import type { ExerciseBlock } from '@core/types'
import { BUNDLED_PYTHON_VERSION, BUNDLED_PYTHON_ID, bundledPythonPath, bundledPythonDir, configureBundledPython } from '../src/main/bundled-python'
import { ensureCourseEnv, findTool, runSteps, stopCourseWork } from '../src/main/toolchain'
import { fixtureCourseDir, readManifest } from './helpers/courses'

const enabled = Boolean(process.env['OPENCOURSE_TEST_PYTHON'])
// Reuse these checks against a relocated, signed package as well as development resources.
if (enabled && process.env['OPENCOURSE_TEST_PYTHON_RUNTIME']) configureBundledPython(process.env['OPENCOURSE_TEST_PYTHON_RUNTIME'])
const tc = pythonToolchain
const floor = tc.parseFloor('>=3.11')

// The committed fixture course's exercise: a test must not depend on content/.
const manifest = readManifest(fixtureCourseDir('python-asyncio')) as unknown as { modules: { lessons: { blocks: ExerciseBlock[] }[] }[] }

function exerciseById(id: string): ExerciseBlock {
  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons ?? []) {
      for (const block of lesson.blocks) {
        if (block.type === 'exercise' && block.id === id) return block
      }
    }
  }
  throw new Error(`no exercise ${id}`)
}

const root = mkdtempSync(join(tmpdir(), 'opencourse-pytest-'))
const courseDir = join(root, 'python-asyncio')
const envDir = join(courseDir, '.venv')
const depsPath = join(courseDir, 'requirements.txt')
const exerciseDir = join(courseDir, 'm', 'l', 'ex-tasks-1')

afterAll(() => {
  if (process.env['OPENCOURSE_KEEP_TMP']) console.log('kept', root)
  else rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!enabled)('python runtime', () => {
  // The body of a skipped describe still runs while tests are collected.
  const exercise = enabled ? exerciseById('ex-tasks-1') : (undefined as never)
  const runtime = { language: 'python', version: '>=3.11', packages: [], flags: [] }
  const deps = (): string => depsFor(runtime, tc.provision?.baseDeps ?? [])
  const envOptions = (): Parameters<typeof ensureCourseEnv>[0] => ({
    toolchain: tc,
    courseDir,
    envDir,
    floor,
    deps: deps(),
    depsPath
  })

  it('finds an interpreter at or above the floor', async () => {
    const { found, tried } = await findTool(tc, floor)
    expect(tried.length).toBeGreaterThan(0)
    expect(found?.path, `tried:\n${tried.join('\n')}`).toBeTruthy()
    expect(found?.version).toBe(BUNDLED_PYTHON_VERSION)
    expect(found?.path).toBe(bundledPythonPath())
  }, 60_000)

  it('builds a working course virtualenv with pytest in it', async () => {
    mkdirSync(exerciseDir, { recursive: true })
    writeFileSync(depsPath, deps())
    writeFileSync(join(exerciseDir, 'test_exercise.py'), exercise.tests ?? '')

    const stages: string[] = []
    const result = await ensureCourseEnv({ ...envOptions(), onProgress: (p) => stages.push(p.stage) })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(existsSync(result.tool)).toBe(true)
    expect(result.envDir).toBe(envDir)
    expect(stages).toContain('ready')
    expect(execFileSync(result.tool, ['-B', '-c', 'import pytest; print(pytest.__version__)']).toString()).toMatch(/^\d+\./)
  }, 300_000)

  it('uses bundled Python with a minimal PATH and clears host Python settings', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')
    vi.stubEnv('PYTHONHOME', '/nonexistent/host/python')
    vi.stubEnv('PYTHONPATH', '/nonexistent/host/modules')
    try {
      const result = await ensureCourseEnv(envOptions())
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) return
      const base = execFileSync(result.tool, ['-I', '-B', '-c', 'import sys, ssl, sqlite3, ctypes; print(sys.base_prefix)']).toString().trim()
      expect(realpathSync(base)).toBe(realpathSync(bundledPythonDir()))
    } finally { vi.unstubAllEnvs() }
  }, 60_000)

  it('checks a higher patch minimum even when the venv already works', async () => {
    const result = await ensureCourseEnv({ ...envOptions(), floor: tc.parseFloor('>=3.14.999') })
    expect(result).toMatchObject({ ok: false, code: 'no-tool' })
    if (!result.ok) expect(result.message).toContain(`bundles Python ${BUNDLED_PYTHON_VERSION}`)
  })

  it('does not fall back to installed Python when the bundle is missing', async () => {
    const original = bundledPythonDir()
    configureBundledPython(join(root, 'missing-bundle'))
    try {
      const result = await ensureCourseEnv(envOptions())
      expect(result).toMatchObject({ ok: false, code: 'no-tool' })
      if (!result.ok) expect(result.message).toContain('Reinstall OpenCourse')
    } finally { configureBundledPython(original) }
  })

  it('rebuilds an unstamped environment without touching learner work', async () => {
    const source = join(exerciseDir, 'exercise.py')
    writeFileSync(source, '# learner work\n')
    rmSync(join(envDir, '.opencourse-runtime.json'))
    const stages: string[] = []
    const result = await ensureCourseEnv({ ...envOptions(), onProgress: p => stages.push(p.stage) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(stages).toContain('creating')
    expect(readFileSync(source, 'utf8')).toBe('# learner work\n')
    expect(JSON.parse(readFileSync(join(envDir, '.opencourse-runtime.json'), 'utf8')).identity).toBe(BUNDLED_PYTHON_ID)
  }, 300_000)

  it('rebuilds after a runtime identity or location change', async () => {
    writeFileSync(join(envDir, '.opencourse-runtime.json'), JSON.stringify({ identity: 'old-runtime', location: '/old/OpenCourse.app' }))
    const stages: string[] = []
    const result = await ensureCourseEnv({ ...envOptions(), onProgress: p => stages.push(p.stage) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(stages).toContain('creating')
  }, 300_000)

  it('cancels environment creation and releases the setup lock', async () => {
    const cancelledCourse = join(root, 'cancelled')
    let started!: () => void
    const creating = new Promise<void>(resolve => { started = resolve })
    const toolchain = { ...tc, provision: { ...tc.provision!, create: () => ['-c', 'import time; time.sleep(60)'] } }
    const setup = ensureCourseEnv({ toolchain, courseDir: cancelledCourse, envDir: join(cancelledCourse, '.venv'), floor, onProgress: p => { if (p.stage === 'creating') started() } })
    await creating
    await stopCourseWork(cancelledCourse)
    expect(await setup).toMatchObject({ ok: false, message: 'Course environment setup was cancelled.' })
    expect(existsSync(join(cancelledCourse, '.opencourse/env.lock'))).toBe(false)
  }, 60_000)

  it('installs changed requirements before updating the dependency stamp', async () => {
    const changed = deps() + 'packaging>=24\n'
    writeFileSync(depsPath, changed)
    const stages: string[] = []
    const result = await ensureCourseEnv({ ...envOptions(), deps: changed, onProgress: p => stages.push(p.stage) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(stages).toContain('installing')
    expect(readFileSync(join(envDir, tc.provision!.stampFile), 'utf8')).toBe(changed)
    writeFileSync(depsPath, deps())
    expect((await ensureCourseEnv(envOptions())).ok).toBe(true)
  }, 300_000)

  it('is a no-op the second time, and concurrent callers share one run', async () => {
    const opts = envOptions()
    const t0 = Date.now()
    const [a, b] = await Promise.all([ensureCourseEnv(opts), ensureCourseEnv(opts)])
    expect(a.ok).toBe(true)
    expect(b).toBe(a) // same shared promise, not a second venv build
    expect(Date.now() - t0).toBeLessThan(20_000)
  }, 60_000)

  const planFor = (): { steps: Parameters<typeof runSteps>[1]['steps'] } => {
    const plan = tc.plan({
      exerciseDir,
      envDir,
      tool: join(envDir, 'bin', 'python'),
      runtime,
      layout: tc.layout,
      hasTests: true,
      match: 'trimmed'
    })
    if (plan.kind !== 'ok') throw new Error(`expected a plan: ${plan.reason}`)
    return { steps: plan.steps }
  }

  const runOn = async (source: string): Promise<{ exitCode: number | null; output: string }> => {
    writeFileSync(join(exerciseDir, 'exercise.py'), source)
    let output = ''
    const outcome = await runSteps(1, {
      toolchain: tc,
      steps: planFor().steps,
      cwd: exerciseDir,
      envDir,
      onData: (chunk) => (output += chunk)
    })
    return { exitCode: outcome.exitCode, output }
  }

  it('fails the untouched starter and passes the reference solution', async () => {
    const starter = await runOn(exercise.starter_code ?? '')
    expect(starter.exitCode, starter.output).not.toBe(0)
    expect(starter.output).toMatch(/failed|error/i)

    const solution = await runOn(exercise.solution ?? '')
    expect(solution.exitCode, solution.output).toBe(0)
    expect(solution.output).toMatch(/passed/)
  }, 180_000)

  it('compares expected output and feeds stdin using the same venv', async () => {
    writeFileSync(join(exerciseDir, 'exercise.py'), 'print(int(input()) * 3)\n')
    const plan = tc.plan({ exerciseDir, envDir, tool: join(envDir, 'bin', 'python'), runtime, layout: tc.layout, hasTests: false, expectedOutput: '6\n', stdin: '2\n', match: 'exact' })
    if (plan.kind !== 'ok') throw new Error(plan.reason)
    const run = () => runSteps(1, { toolchain: tc, steps: plan.steps, cwd: exerciseDir, envDir, onData: () => {} })
    expect((await run()).exitCode).toBe(0)
    writeFileSync(join(exerciseDir, 'exercise.py'), 'print(int(input()) * 4)\n')
    expect((await run()).exitCode).not.toBe(0)
  })

  it('does not let a stale __pycache__ turn a failure into a pass', async () => {
    // Green first, so a .pyc of the passing version exists...
    expect((await runOn(exercise.solution ?? '')).exitCode).toBe(0)
    execFileSync('mkdir', ['-p', join(exerciseDir, '__pycache__')])
    // ...then break it. A cached module would still report a pass.
    const broken = await runOn(exercise.starter_code ?? '')
    expect(broken.exitCode, broken.output).not.toBe(0)
  }, 180_000)

  it('kills a run that never finishes', async () => {
    writeFileSync(join(exerciseDir, 'exercise.py'), 'while True:\n    pass\n')
    const outcome = await runSteps(2, {
      toolchain: tc,
      steps: planFor().steps,
      cwd: exerciseDir,
      envDir,
      onData: () => {},
      timeoutMs: 5_000
    })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).not.toBe(0)
  }, 60_000)
})
