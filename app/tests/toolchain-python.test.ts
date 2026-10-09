/** The Python descriptor: discovery order, floors, and the pytest-only plan. */
import { describe, expect, it } from 'vitest'
import { childEnv } from '@core/runner'
import { pythonToolchain, venvPython } from '@core/toolchains/python'
import type { PlanContext } from '@core/toolchains/types'

const tc = pythonToolchain

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    exerciseDir: '/w/course/m/l/ex-1',
    envDir: '/w/course/.venv',
    tool: venvPython('/w/course/.venv'),
    runtime: { language: 'python', version: '>=3.11', packages: [], flags: [] },
    layout: tc.layout,
    hasTests: true,
    match: 'trimmed',
    ...overrides
  }
}

describe('bundled interpreter', () => {
  it('has no system discovery candidates or developer tools requirement', () => {
    expect(tc.discovery.names).toEqual([])
    expect(tc.discovery.fallbackNames).toEqual([])
    expect(tc.discovery.searchDirs('/Users/me')).toEqual([])
    expect(tc.discovery.needsCommandLineTools).toBe(false)
  })
  it('checks the patch version as well as major and minor', () => {
    expect(tc.discovery.probeArgs(tc.parseFloor('>=3.14.8')).join(' ')).toContain('sys.version_info[:3] >= (3, 14, 8)')
  })
})

describe('parseFloor', () => {
  it.each([
    ['>=3.11', '3.11'],
    ['>= 3.12.1', '3.12.1'],
    ['3.13', '3.13'],
    [undefined, '3.11'],
  ])('%s -> %s', (spec, label) => {
    const floor = tc.parseFloor(spec as string | undefined)
    expect(floor.kind).toBe('semver')
    expect(floor.label).toBe(label)
  })

  it('names the language in its version label', () => {
    expect(tc.versionLabel(tc.parseFloor('>=3.12'))).toBe('Python 3.12')
  })

  it('rejects expressions that are not minimum requirements', () => {
    for (const spec of ['garbage', '<3.15', '==3.14', '>=3.11,<3.15', '3', '3.15.0rc3']) expect(() => tc.parseFloor(spec)).toThrow('Minimum Python version')
  })

  it('suggests updating the app instead of installing system Python', () => {
    expect(tc.installHint(tc.parseFloor('>=3.15'))[0]).toContain('Update OpenCourse')
  })
})

describe('plan', () => {
  it('routes pytest through the venv interpreter, keeping the flags', () => {
    const plan = tc.plan(context())
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.argv.slice(0, 4)).toEqual(['/w/course/.venv/bin/python', '-m', 'pytest', '-q'])
  })

  it('keeps .pytest_cache out of the learner folder', () => {
    const plan = tc.plan(context())
    if (plan.kind !== 'ok') throw new Error('expected ok')
    expect(plan.steps[0]?.argv).toContain('no:cacheprovider')
  })

  it('does not double up the cache flag', () => {
    const plan = tc.plan(context({ testCommand: 'pytest -q -p no:cacheprovider' }))
    if (plan.kind !== 'ok') throw new Error('expected ok')
    expect(plan.steps[0]?.argv.filter((a) => a === 'no:cacheprovider')).toHaveLength(1)
  })

  it('refuses shell syntax rather than quoting around it', () => {
    for (const testCommand of ['pytest -q; rm -rf ~', 'pytest -q && echo hi', 'pytest $(id)', 'pytest `id`']) {
      expect(tc.plan(context({ testCommand })).kind).toBe('unsupported')
    }
  })

  it('refuses anything that is not pytest', () => {
    expect(tc.plan(context({ testCommand: 'python run_checks.py' })).kind).toBe('unsupported')
    expect(tc.plan(context({ testCommand: '' })).kind).toBe('unsupported')
  })

  it('runs the learner program against an expected-output contract instead', () => {
    const plan = tc.plan(context({ hasTests: false, expectedOutput: 'Hello, world\n', stdin: '2\n' }))
    if (plan.kind !== 'ok') throw new Error('expected ok')
    expect(plan.steps[0]?.argv).toEqual(['/w/course/.venv/bin/python', 'exercise.py'])
    expect(plan.steps[0]?.expect).toEqual({ stdout: 'Hello, world\n', match: 'trimmed' })
    expect(plan.steps[0]?.stdin).toBe('2\n')
  })

  it('refuses an exercise with nothing to verify', () => {
    expect(tc.plan(context({ hasTests: false })).kind).toBe('unsupported')
  })
})

describe('environment', () => {
  it('puts the venv first on PATH and exports VIRTUAL_ENV', () => {
    const provision = tc.provision
    if (!provision) throw new Error('Python provisions an environment')
    const env = childEnv({
      base: { PATH: '/usr/bin:/bin', PYTHONHOME: '/host', PYTHONPATH: '/host/modules' },
      pathDirs: [provision.binDir('/w/course/.venv'), '/opt/homebrew/bin'],
      extra: tc.extraEnv({ envDir: '/w/course/.venv' })
    })
    expect(env['PATH']).toBe('/w/course/.venv/bin:/opt/homebrew/bin:/usr/bin:/bin')
    expect(env['VIRTUAL_ENV']).toBe('/w/course/.venv')
    expect(env['PYTHONHOME']).toBeUndefined()
    expect(env['PYTHONPATH']).toBeUndefined()
  })

  it('never lets a stale __pycache__ decide the verdict', () => {
    expect(tc.extraEnv({})['PYTHONDONTWRITEBYTECODE']).toBe('1')
    expect(tc.layout.staleArtifacts).toContain('__pycache__')
  })

  it('builds the venv and installs the requirements with the venv pip', () => {
    const provision = tc.provision
    if (!provision) throw new Error('Python provisions an environment')
    expect(provision.create('/w/.venv')).toEqual(['-m', 'venv', '--clear', '/w/.venv'])
    expect(provision.exe('/w/.venv')).toBe('/w/.venv/bin/python')
    expect(provision.install('/w/requirements.txt')).toContain('pip')
    expect(provision.baseDeps.join(' ')).toContain('pytest')
  })
})
