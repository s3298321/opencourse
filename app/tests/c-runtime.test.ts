/**
 * Real-compiler integration: compiles and runs C for real, so it is opt-in like
 * the Python one. A compile is fast (~0.3 s), but this still spawns processes.
 *
 *   OPENCOURSE_TEST_C=1 npx vitest run tests/c-runtime.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cToolchain } from '@core/toolchains'
import type { PlanContext } from '@core/toolchains/types'
import { ensureCourseEnv, findTool, runSteps } from '../src/main/toolchain'

const enabled = Boolean(process.env['OPENCOURSE_TEST_C'])
const tc = cToolchain
const floor = tc.parseFloor('>=c17')

const root = mkdtempSync(join(tmpdir(), 'opencourse-c-'))
const courseDir = join(root, 'intro-to-c')
const exerciseDir = join(courseDir, 'm', 'l', 'ex-1')

const HEADER = 'int add(int a, int b);\n'
const TESTS = `#include <assert.h>
#include <stdio.h>
#include "exercise.h"

int main(void) {
  assert(add(2, 2) == 4);
  assert(add(-1, 1) == 0);
  puts("2 checks passed");
  return 0;
}
`
const SOLUTION = '#include "exercise.h"\n\nint add(int a, int b) { return a + b; }\n'
const STARTER = '#include "exercise.h"\n\nint add(int a, int b) { (void)a; (void)b; return 0; }\n'

afterAll(() => {
  if (process.env['OPENCOURSE_KEEP_TMP']) console.log('kept', root)
})

describe.skipIf(!enabled)('c runtime', () => {
  const runtime = { language: 'c', version: '>=c17', packages: [], flags: ['-Wall', '-Wextra'] }

  function context(tool: string, overrides: Partial<PlanContext> = {}): PlanContext {
    return { exerciseDir, tool, runtime, layout: tc.layout, hasTests: true, match: 'trimmed', ...overrides }
  }

  async function tool(): Promise<string> {
    const env = await ensureCourseEnv({ toolchain: tc, courseDir, floor })
    if (!env.ok) throw new Error(`no compiler: ${env.message}`)
    return env.tool
  }

  const runOn = async (
    source: string,
    overrides: Partial<PlanContext> = {},
    timeoutMs?: number
  ): Promise<{ exitCode: number | null; output: string; failedStep?: string }> => {
    writeFileSync(join(exerciseDir, 'exercise.c'), source)
    const plan = tc.plan(context(await tool(), overrides))
    if (plan.kind !== 'ok') throw new Error(`expected a plan: ${plan.reason}`)
    let output = ''
    const outcome = await runSteps(1, {
      toolchain: tc,
      steps: plan.steps,
      cwd: exerciseDir,
      onData: (chunk) => (output += chunk),
      timeoutMs
    })
    return { exitCode: outcome.exitCode, output, failedStep: outcome.failedStep }
  }

  it('finds a compiler that accepts the standard the course asked for', async () => {
    const { found, tried } = await findTool(tc, floor)
    expect(tried.length).toBeGreaterThan(0)
    expect(found?.path, `tried:\n${tried.join('\n')}`).toBeTruthy()
    expect(found?.version).toBeTruthy()
  }, 60_000)

  it('needs no per-course environment, and caches the answer', async () => {
    const a = await ensureCourseEnv({ toolchain: tc, courseDir, floor })
    const b = await ensureCourseEnv({ toolchain: tc, courseDir, floor })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.envDir).toBeUndefined()
    expect(b).toEqual(a)
    // No .venv-shaped directory was created next to the course.
    expect(existsSync(join(courseDir, '.venv'))).toBe(false)
  }, 60_000)

  it('fails the untouched starter and passes the reference solution', async () => {
    mkdirSync(exerciseDir, { recursive: true })
    writeFileSync(join(exerciseDir, 'exercise.h'), HEADER)
    writeFileSync(join(exerciseDir, 'test_exercise.c'), TESTS)

    const starter = await runOn(STARTER)
    expect(starter.exitCode, starter.output).not.toBe(0)
    expect(starter.failedStep).toBe('run')

    const solution = await runOn(SOLUTION)
    expect(solution.exitCode, solution.output).toBe(0)
    expect(solution.output).toContain('2 checks passed')
  }, 120_000)

  it('puts compiler diagnostics in the output and stops before running', async () => {
    const broken = await runOn('#include "exercise.h"\nint add(int a, int b) { return a + }\n')
    expect(broken.exitCode).not.toBe(0)
    expect(broken.failedStep).toBe('compile')
    expect(broken.output).toMatch(/error/i)
  }, 60_000)

  it('does not let a stale binary turn a failure into a pass', async () => {
    // Green first, so a working binary exists...
    expect((await runOn(SOLUTION)).exitCode).toBe(0)
    expect(existsSync(join(exerciseDir, '.opencourse-build', 'check'))).toBe(true)
    // ...then break it so it cannot even compile. A surviving binary would pass.
    const broken = await runOn('#include "exercise.h"\nint add(int a, int b) { return a + }\n')
    expect(broken.exitCode, broken.output).not.toBe(0)
  }, 120_000)

  it('verifies a whole program against its expected output', async () => {
    const program = '#include <stdio.h>\nint main(void) { puts("Hello, world"); return 0; }\n'
    const ok = await runOn(program, { hasTests: false, expectedOutput: 'Hello, world\n' })
    expect(ok.exitCode, ok.output).toBe(0)

    const wrong = await runOn('#include <stdio.h>\nint main(void) { puts("Goodbye"); return 0; }\n', {
      hasTests: false,
      expectedOutput: 'Hello, world\n'
    })
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.output).toContain('expected:')
  }, 120_000)

  it('reads stdin when the course supplies it', async () => {
    const program = '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("%d\\n", n * 2); return 0; }\n'
    const ok = await runOn(program, { hasTests: false, expectedOutput: '42\n', stdin: '21\n' })
    expect(ok.exitCode, ok.output).toBe(0)
  }, 60_000)

  it('lets the sanitizer be the grader', async () => {
    // This is the whole point of runtime.flags: the exercise is wrong in a way
    // only a sanitizer can see, and the app must report that as a failure.
    //
    // UBSan, not ASan: an -fsanitize=address binary hangs at startup on
    // macOS 26 / Apple clang 17 (see the note in core/toolchains/c.ts), so no
    // course may be graded by it.
    const outOfBounds = `#include "exercise.h"
int add(int a, int b) {
  int table[4] = {0, 1, 2, 3};
  return table[a + b];
}
`
    const flags = ['-fsanitize=undefined', '-fno-sanitize-recover=all', '-g']
    const result = await runOn(outOfBounds, {
      runtime: { language: 'c', version: '>=c17', packages: [], flags }
    })
    expect(result.exitCode, result.output).not.toBe(0)
    expect(result.output).toMatch(/runtime error|out of bounds/i)
    expect(result.failedStep).toBe('run')
  }, 120_000)

  it('kills a run that never finishes', async () => {
    const spin = '#include "exercise.h"\nint add(int a, int b) { while (1) { } return a + b; }\n'
    const result = await runOn(spin, {}, 5_000)
    expect(result.exitCode).not.toBe(0)
  }, 60_000)
})
