/**
 * Real-compiler integration for hand-written IR: compiles, links and runs for
 * real, so it is opt-in like the C and Python ones.
 *
 *   OPENCOURSE_TEST_LLVM=1 npx vitest run tests/llvm-runtime.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { llvmIrToolchain } from '@core/toolchains'
import type { PlanContext } from '@core/toolchains/types'
import { ensureCourseEnv, findTool, runSteps } from '../src/main/toolchain'

const enabled = Boolean(process.env['OPENCOURSE_TEST_LLVM'])
const tc = llvmIrToolchain
const floor = tc.parseFloor(undefined)

const root = mkdtempSync(join(tmpdir(), 'opencourse-llvm-'))
const courseDir = join(root, 'intro-to-llvm')
const exerciseDir = join(courseDir, 'm', 'l', 'ex-1')

const TESTS = `#include <assert.h>
#include <stdio.h>
#include <stdint.h>

int32_t add(int32_t a, int32_t b);

int main(void) {
  assert(add(2, 2) == 4);
  assert(add(-1, 1) == 0);
  puts("2 checks passed");
  return 0;
}
`
const SOLUTION = 'define i32 @add(i32 %a, i32 %b) {\n  %sum = add i32 %a, %b\n  ret i32 %sum\n}\n'
const STARTER = 'define i32 @add(i32 %a, i32 %b) {\n  ret i32 %a\n}\n'

/** Parses, but the verifier rejects it: %late is used before it is defined. */
const UNDOMINATED = `define i32 @add(i32 %a, i32 %b) {
entry:
  br label %next
next:
  %sum = add i32 %a, %late
  %late = add i32 %b, 0
  ret i32 %sum
}
`

/** Parses, but the verifier rejects it: the phi forgets one predecessor. */
const SHORT_PHI = `define i32 @add(i32 %a, i32 %b) {
entry:
  %neg = icmp slt i32 %b, 0
  br i1 %neg, label %left, label %right
left:
  br label %join
right:
  br label %join
join:
  %x = phi i32 [ %a, %left ]
  ret i32 %x
}
`

describe.skipIf(!enabled)('llvm-ir runtime', () => {
  function context(tool: string, overrides: Partial<PlanContext> = {}): PlanContext {
    return {
      exerciseDir,
      tool,
      runtime: { language: 'llvm-ir', packages: [], flags: [] },
      layout: tc.layout,
      hasTests: true,
      match: 'trimmed',
      ...overrides
    }
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
    mkdirSync(exerciseDir, { recursive: true })
    writeFileSync(join(exerciseDir, 'test_exercise.c'), TESTS)
    writeFileSync(join(exerciseDir, 'exercise.ll'), source)
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

  it('finds a clang that reads IR and verifies it', async () => {
    const { found, tried } = await findTool(tc, floor)
    expect(found?.path, `tried:\n${tried.join('\n')}`).toBeTruthy()
    expect(found?.version).toMatch(/clang/i)
  }, 60_000)

  it('fails the starter in the run step and passes the solution', async () => {
    const starter = await runOn(STARTER)
    expect(starter.exitCode, starter.output).not.toBe(0)
    expect(starter.failedStep).toBe('run')

    const solution = await runOn(SOLUTION)
    expect(solution.exitCode, solution.output).toBe(0)
    expect(solution.output).toContain('2 checks passed')
    // A module with no target triple is normal for hand-written IR.
    expect(solution.output).not.toContain('override-module')
  }, 120_000)

  it('reports a parse error with its line, in the compile step', async () => {
    const broken = await runOn('define i32 @add(i32 %a, i32 %b) {\n  %s = add i32 %a, %c\n  ret i32 %s\n}\n')
    expect(broken.failedStep).toBe('compile')
    expect(broken.output).toContain("use of undefined value '%c'")
  }, 60_000)

  it('runs the verifier, which release clang skips for IR input', async () => {
    for (const [source, message] of [
      [UNDOMINATED, 'Instruction does not dominate all uses'],
      [SHORT_PHI, 'PHINode should have one entry for each predecessor']
    ] as const) {
      const result = await runOn(source)
      expect(result.failedStep, result.output).toBe('compile')
      expect(result.output).toContain(message)
      // The bug-report banner would bury the one line that matters.
      expect(result.output).not.toContain('PLEASE ATTACH')
    }
  }, 120_000)

  it('does not let a stale object turn a failure into a pass', async () => {
    expect((await runOn(SOLUTION)).exitCode).toBe(0)
    expect(existsSync(join(exerciseDir, '.opencourse-build', 'exercise.o'))).toBe(true)
    const broken = await runOn('define i32 @add(i32 %a, i32 %b) {\n  ret i32\n}\n')
    expect(broken.exitCode, broken.output).not.toBe(0)
  }, 120_000)

  it('verifies a whole IR program by what its @main printed', async () => {
    const program = `@msg = private constant [13 x i8] c"Hello, world\\00"

declare i32 @puts(ptr)

define i32 @main() {
  %r = call i32 @puts(ptr @msg)
  ret i32 0
}
`
    const ok = await runOn(program, { hasTests: false, expectedOutput: 'Hello, world\n' })
    expect(ok.exitCode, ok.output).toBe(0)

    const wrong = await runOn(program, { hasTests: false, expectedOutput: 'Goodbye\n' })
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.output).toContain('expected:')
  }, 120_000)

  it('kills a run that never finishes', async () => {
    const spin = 'define i32 @add(i32 %a, i32 %b) {\nentry:\n  br label %entry2\nentry2:\n  br label %entry2\n}\n'
    const result = await runOn(spin, {}, 5_000)
    expect(result.exitCode).not.toBe(0)
  }, 60_000)
})
