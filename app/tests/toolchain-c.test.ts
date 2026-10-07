/** The C descriptor: two exercise shapes, and what a course may ask the compiler for. */
import { describe, expect, it } from 'vitest'
import { cToolchain } from '@core/toolchains/c'
import { compareOutput } from '@core/toolchains/output'
import type { PlanContext } from '@core/toolchains/types'

const tc = cToolchain

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    exerciseDir: '/w/course/m/l/ex-1',
    tool: '/usr/bin/cc',
    runtime: { language: 'c', version: '>=c17', packages: [], flags: [] },
    layout: tc.layout,
    hasTests: true,
    match: 'trimmed',
    ...overrides
  }
}

describe('layout', () => {
  it('has no environment to build and no dependency file', () => {
    expect(tc.provision).toBeUndefined()
    expect(tc.layout.envDirName).toBeUndefined()
    expect(tc.layout.depsFile).toBeUndefined()
  })

  it('wipes the build directory so a stale binary cannot pass', () => {
    expect(tc.layout.buildDirName).toBe('.opencourse-build')
    expect(tc.layout.staleArtifacts).toContain('.opencourse-build')
  })
})

describe('discovery', () => {
  it('prefers cc, and gates /usr/bin on the Command Line Tools', () => {
    expect(tc.discovery.names[0]).toBe('cc')
    expect(tc.discovery.searchDirs('/Users/me')[0]).toBe('/usr/bin')
    // /usr/bin/cc exists without the tools installed; invoking it pops Apple's
    // installer dialog, so findTool skips it until the check passes.
    expect(tc.discovery.needsCommandLineTools).toBe(true)
    expect(tc.installHint(tc.parseFloor(undefined))[0]).toBe('xcode-select --install')
  })

  it('probes by compiling from stdin, so the standard itself is verified', () => {
    const floor = tc.parseFloor('>=c17')
    expect(tc.discovery.probeArgs(floor)).toEqual(['-x', 'c', '-std=c17', '-fsyntax-only', '-'])
    expect(tc.discovery.probeInput?.(floor)).toContain('int main(void)')
  })
})

describe('parseFloor', () => {
  it.each([
    ['>=c17', 'c17'],
    ['c11', 'c11'],
    ['C99', 'c99'],
    ['gnu17', 'gnu17'],
    [undefined, 'c17'],
    ['garbage', 'c17']
  ])('%s -> %s', (spec, std) => {
    const floor = tc.parseFloor(spec as string | undefined)
    expect(floor.kind).toBe('std')
    if (floor.kind !== 'std') return
    expect(floor.std).toBe(std)
    expect(floor.label).toBe(std.toUpperCase())
  })
})

describe('versionLabel', () => {
  it('does not repeat the language, because "C17" already carries it', () => {
    expect(tc.versionLabel(tc.parseFloor('>=c17'))).toBe('C17')
    expect(tc.versionLabel(tc.parseFloor('c11'))).toBe('C11')
  })
})

describe('plan: the unit shape', () => {
  it('compiles both translation units, then runs the binary', () => {
    const plan = tc.plan(context())
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.steps.map((s) => s.label)).toEqual(['compile', 'run'])

    const compile = plan.steps[0]?.argv ?? []
    expect(compile[0]).toBe('/usr/bin/cc')
    expect(compile).toContain('-std=c17')
    expect(compile.slice(compile.indexOf('-o'))).toEqual([
      '-o',
      '/w/course/m/l/ex-1/.opencourse-build/check',
      'exercise.c',
      'test_exercise.c'
    ])
    expect(plan.steps[1]?.argv).toEqual(['/w/course/m/l/ex-1/.opencourse-build/check'])
  })

  it('never compares stdout when a test main owns the verdict', () => {
    const plan = tc.plan(context({ expectedOutput: 'ignored' }))
    if (plan.kind !== 'ok') throw new Error('expected ok')
    expect(plan.steps[1]?.expect).toBeUndefined()
  })

  it('passes the course flags and links its libraries', () => {
    const plan = tc.plan(
      context({
        runtime: {
          language: 'c',
          version: '>=c17',
          packages: ['m'],
          flags: ['-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-g']
        }
      })
    )
    if (plan.kind !== 'ok') throw new Error('expected ok')
    const compile = plan.steps[0]?.argv ?? []
    expect(compile).toContain('-fsanitize=address,undefined')
    expect(compile).toContain('-Werror')
    expect(compile[compile.length - 1]).toBe('-lm')
  })
})

describe('plan: the program shape', () => {
  it('compiles the learner file alone and compares its stdout', () => {
    const plan = tc.plan(
      context({ hasTests: false, expectedOutput: 'Hello, world\n', stdin: '3\n', match: 'lines' })
    )
    if (plan.kind !== 'ok') throw new Error('expected ok')
    expect(plan.steps[0]?.argv).toContain('exercise.c')
    expect(plan.steps[0]?.argv).not.toContain('test_exercise.c')
    expect(plan.steps[1]?.expect).toEqual({ stdout: 'Hello, world\n', match: 'lines' })
    expect(plan.steps[1]?.stdin).toBe('3\n')
  })

  it('refuses an exercise with nothing to verify', () => {
    expect(tc.plan(context({ hasTests: false })).kind).toBe('unsupported')
  })
})

describe('plan: what a manifest may not ask for', () => {
  it('refuses to let a course choose the output path', () => {
    const plan = tc.plan(context({ runtime: { language: 'c', packages: [], flags: ['-o', '/tmp/evil'] } }))
    expect(plan.kind).toBe('unsupported')
  })

  it('refuses shell syntax and anything carrying a path', () => {
    for (const flag of ['-Wall; rm -rf ~', '-fplugin=/tmp/evil.dylib', '-I/etc', '$(id)']) {
      const plan = tc.plan(context({ runtime: { language: 'c', packages: [], flags: [flag] } }))
      expect(plan.kind, flag).toBe('unsupported')
    }
  })

  it('refuses a library name that is not one', () => {
    const plan = tc.plan(context({ runtime: { language: 'c', packages: ['m; id'], flags: [] } }))
    expect(plan.kind).toBe('unsupported')
  })

  it('allows the flags an intro course actually needs', () => {
    const flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-pedantic', '-g3', '-O2', '-DDEBUG=1', '-fsanitize=undefined']
    const plan = tc.plan(context({ runtime: { language: 'c', packages: [], flags } }))
    expect(plan.kind).toBe('ok')
  })
})

describe('displayCommand', () => {
  it('reads as something a learner could paste, without the app-only flags', () => {
    const shown = tc.displayCommand({
      exerciseDir: '/w/course/m/l/ex-1',
      courseDir: '/w/course',
      runtime: { language: 'c', version: '>=c17', packages: ['m'], flags: ['-Wall'] },
      layout: tc.layout,
      hasTests: true
    })
    expect(shown).toBe('cc -std=c17 -Wall -o .opencourse-build/check exercise.c test_exercise.c -lm && ./.opencourse-build/check')
    expect(shown).not.toContain('-fcolor-diagnostics')
  })
})

describe('compareOutput', () => {
  it('ignores a trailing newline and trailing blank lines by default', () => {
    expect(compareOutput('Hello\n', { stdout: 'Hello', match: 'trimmed' }).ok).toBe(true)
    expect(compareOutput('Hello\n\n\n', { stdout: 'Hello\n', match: 'trimmed' }).ok).toBe(true)
  })

  it('is byte-exact when asked', () => {
    expect(compareOutput('Hello\n', { stdout: 'Hello', match: 'exact' }).ok).toBe(false)
  })

  it('ignores leading indentation under lines', () => {
    expect(compareOutput('  a\n  b\n', { stdout: 'a\nb', match: 'lines' }).ok).toBe(true)
    expect(compareOutput('  a\n  b\n', { stdout: 'a\nb', match: 'trimmed' }).ok).toBe(false)
  })

  it('reports which line first differed, and both sides', () => {
    const verdict = compareOutput('1\n9\n3\n', { stdout: '1\n2\n3\n', match: 'trimmed' })
    expect(verdict.ok).toBe(false)
    expect(verdict.report).toContain('line 2')
    expect(verdict.report).toContain('expected:')
    expect(verdict.report).toContain('got:')
  })

  it('handles CRLF from a program that writes Windows line endings', () => {
    expect(compareOutput('a\r\nb\r\n', { stdout: 'a\nb', match: 'trimmed' }).ok).toBe(true)
  })
})
