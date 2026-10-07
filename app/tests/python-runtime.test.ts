/**
 * Real-Python integration. Creates a virtualenv and runs pytest, so it is slow
 * and opt-in: OPENCOURSE_TEST_PYTHON=1 npx vitest run tests/python-runtime.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { depsFor } from '@core/scaffold'
import { pythonToolchain } from '@core/toolchains'
import type { ExerciseBlock } from '@core/types'
import { ensureCourseEnv, findTool, runSteps } from '../src/main/toolchain'

const enabled = Boolean(process.env['OPENCOURSE_TEST_PYTHON'])
const tc = pythonToolchain
const floor = tc.parseFloor('>=3.11')

// Read only when the test is asked for: an opt-in test must not fail a plain `npm test`.
const manifest = (enabled ? JSON.parse(
  readFileSync(join(__dirname, '../../content/python-asyncio/course.json'), 'utf8')
) : { modules: [] }) as { modules: { lessons: { blocks: ExerciseBlock[] }[] }[] }

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
    expect(found?.version).toMatch(/^3\.(1[1-9]|[2-9]\d)\./)
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
    expect(execFileSync(result.tool, ['-c', 'import pytest; print(pytest.__version__)']).toString()).toMatch(/^\d+\./)
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
