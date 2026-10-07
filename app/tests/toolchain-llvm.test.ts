/** The LLVM IR descriptor: a verified compile of the learner's IR, then a link, then a run. */
import { describe, expect, it } from 'vitest'
import { getToolchain, hasToolchain } from '@core/toolchains'
import { llvmIrToolchain } from '@core/toolchains/llvm'
import type { PlanContext } from '@core/toolchains/types'

const tc = llvmIrToolchain

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    exerciseDir: '/w/course/m/l/ex-1',
    tool: '/usr/bin/cc',
    runtime: { language: 'llvm-ir', packages: [], flags: [] },
    layout: tc.layout,
    hasTests: true,
    match: 'trimmed',
    ...overrides
  }
}

function steps(overrides: Partial<PlanContext> = {}): { label: string; argv: string[] }[] {
  const plan = tc.plan(context(overrides))
  if (plan.kind !== 'ok') throw new Error(`expected a plan: ${plan.reason}`)
  return plan.steps
}

describe('registry', () => {
  it('is a language a manifest can name', () => {
    expect(hasToolchain('llvm-ir')).toBe(true)
    expect(getToolchain('llvm-ir')).toBe(tc)
  })
})

describe('layout', () => {
  it('has the learner write a .ll file against a C harness', () => {
    expect(tc.layout.learnerFile).toBe('exercise.ll')
    expect(tc.layout.testFile).toBe('test_exercise.c')
    expect(tc.layout.solutionFile).toBe('solution.ll')
  })

  it('has no environment to build, and wipes its build output', () => {
    expect(tc.provision).toBeUndefined()
    expect(tc.layout.depsFile).toBeUndefined()
    expect(tc.layout.staleArtifacts).toContain(tc.layout.buildDirName)
  })
})

describe('discovery', () => {
  it('never tries gcc, which cannot read IR', () => {
    expect(tc.discovery.names).not.toContain('gcc')
    expect(tc.discovery.names[0]).toBe('cc')
  })

  it('reaches the keg-only Homebrew clang, which no PATH contains', () => {
    expect(tc.discovery.searchDirs('/Users/me')).toContain('/opt/homebrew/opt/llvm/bin')
    expect(tc.discovery.searchDirs('/Users/me')[0]).toBe('/usr/bin')
    expect(tc.discovery.needsCommandLineTools).toBe(true)
  })

  it('probes with the flags a run uses, on IR that needs opaque pointers', () => {
    const floor = tc.parseFloor(undefined)
    const probe = tc.discovery.probeArgs(floor)
    expect(probe.slice(0, 2)).toEqual(['-x', 'ir'])
    expect(probe).toContain('-fverify-intermediate-code')
    expect(probe[probe.length - 1]).toBe('-')
    expect(tc.discovery.probeInput?.(floor)).toContain('ptr %p')
  })
})

describe('versions', () => {
  it('has one floor whatever the manifest says, and never throws', () => {
    for (const spec of [undefined, '>=15', 'garbage', '']) {
      expect(tc.versionLabel(tc.parseFloor(spec))).toBe('LLVM IR')
    }
  })
})

describe('plan: the unit shape', () => {
  it('compiles the IR alone, links it against the harness, then runs', () => {
    const [compile, link, run] = steps()
    expect([compile?.label, link?.label, run?.label]).toEqual(['compile', 'link', 'run'])

    expect(compile?.argv[0]).toBe('/usr/bin/cc')
    expect(compile?.argv.slice(-4)).toEqual(['-c', '-o', '/w/course/m/l/ex-1/.opencourse-build/exercise.o', 'exercise.ll'])
    expect(compile?.argv).not.toContain('test_exercise.c')

    expect(link?.argv).toContain('-std=c17')
    expect(link?.argv.slice(link.argv.indexOf('-o'))).toEqual([
      '-o',
      '/w/course/m/l/ex-1/.opencourse-build/check',
      '/w/course/m/l/ex-1/.opencourse-build/exercise.o',
      'test_exercise.c'
    ])
    expect(run?.argv).toEqual(['/w/course/m/l/ex-1/.opencourse-build/check'])
  })

  it('turns the IR verifier on, which a release clang leaves off for IR input', () => {
    const [compile] = steps()
    expect(compile?.argv).toContain('-fverify-intermediate-code')
    // A verifier failure is a backend fatal error; without this clang writes
    // reproducer files and a bug-report banner for an ordinary mistake.
    expect(compile?.argv).toContain('-fno-crash-diagnostics')
  })

  it('keeps its own IR flags after the course flags, so a course cannot undo them', () => {
    const [compile] = steps({ runtime: { language: 'llvm-ir', packages: [], flags: ['-Weverything', '-O2'] } })
    const argv = compile?.argv ?? []
    expect(argv.indexOf('-Wno-override-module')).toBeGreaterThan(argv.indexOf('-Weverything'))
    expect(argv).toContain('-O2')
  })

  it('passes course flags to the harness too, and links libraries last', () => {
    const [, link] = steps({ runtime: { language: 'llvm-ir', packages: ['m'], flags: ['-Wall', '-Werror'] } })
    expect(link?.argv).toContain('-Werror')
    expect(link?.argv[link.argv.length - 1]).toBe('-lm')
  })

  it('never compares stdout when a test main owns the verdict', () => {
    const [, , run] = steps({ expectedOutput: 'ignored' }) as { expect?: unknown }[]
    expect(run?.expect).toBeUndefined()
  })
})

describe('plan: the program shape', () => {
  it('links the IR alone and compares what its @main printed', () => {
    const plan = tc.plan(context({ hasTests: false, expectedOutput: 'Hello\n', stdin: '3\n', match: 'lines' }))
    if (plan.kind !== 'ok') throw new Error('expected ok')
    const [, link, run] = plan.steps
    expect(link?.argv).not.toContain('test_exercise.c')
    expect(link?.argv).not.toContain('-std=c17')
    expect(run?.expect).toEqual({ stdout: 'Hello\n', match: 'lines' })
    expect(run?.stdin).toBe('3\n')
  })

  it('refuses an exercise with nothing to verify', () => {
    expect(tc.plan(context({ hasTests: false })).kind).toBe('unsupported')
  })
})

describe('plan: what a manifest may not ask for', () => {
  it('refuses an output path, shell syntax, and anything carrying a path', () => {
    for (const flag of ['-o', '-Wall; id', '-fplugin=/tmp/evil.dylib', '-load', '-mllvm']) {
      const plan = tc.plan(context({ runtime: { language: 'llvm-ir', packages: [], flags: [flag] } }))
      expect(plan.kind, flag).toBe('unsupported')
    }
  })

  it('refuses a library name that is not one', () => {
    const plan = tc.plan(context({ runtime: { language: 'llvm-ir', packages: ['m; id'], flags: [] } }))
    expect(plan.kind).toBe('unsupported')
  })
})

describe('displayCommand', () => {
  it('shows the three commands a learner could type, without the colour flag', () => {
    const shown = tc.displayCommand({
      exerciseDir: '/w/course/m/l/ex-1',
      courseDir: '/w/course',
      runtime: { language: 'llvm-ir', packages: [], flags: [] },
      layout: tc.layout,
      hasTests: true
    })
    expect(shown).toContain('exercise.ll')
    expect(shown).toContain('test_exercise.c')
    expect(shown).toContain('./.opencourse-build/check')
    expect(shown).not.toContain('-fcolor-diagnostics')
    expect(shown.split(' && ')).toHaveLength(3)
  })
})
