/** The Python descriptor: discovery order, floors, and the pytest-only plan. */
import { describe, expect, it } from 'vitest'
import { childEnv } from '@core/runner'
import { pythonToolchain, PYTHON_NAMES, pythonSearchDirs, venvPython } from '@core/toolchains/python'
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

describe('interpreter discovery', () => {
  it('probes newest Python first', () => {
    expect(PYTHON_NAMES[0]).toBe('python3.14')
    expect([...PYTHON_NAMES]).toEqual([...PYTHON_NAMES].sort().reverse())
    expect(tc.discovery.names).toEqual(PYTHON_NAMES)
  })

  it('looks in the places a GUI process cannot reach through PATH', () => {
    const dirs = pythonSearchDirs('/Users/me')
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs).toContain('/Users/me/.pyenv/shims')
    expect(dirs).toContain('/Library/Frameworks/Python.framework/Versions/3.12/bin')
    expect(dirs[0]).toBe('/opt/homebrew/bin')
  })

  it('keeps bare names out of the absolute candidates', () => {
    // findTool composes searchDirs x names for the absolute pass; python3 is the
    // CLT shim on a bare macOS, so it is opt-in through fallbackNames only.
    expect(`${pythonSearchDirs('/Users/me')[0]}/${tc.discovery.names[0]}`).toBe('/opt/homebrew/bin/python3.14')
    expect(tc.discovery.names).not.toContain('python3')
    expect(tc.discovery.fallbackNames).toContain('python3')
    expect(tc.discovery.needsCommandLineTools).toBe(true)
  })

  it('builds a probe that exits 0 only at or above the floor', () => {
    expect(tc.discovery.probeArgs(tc.parseFloor('>=3.11')).join(' ')).toContain('sys.version_info[:2] >= (3, 11)')
  })
})

describe('parseFloor', () => {
  it.each([
    ['>=3.11', '3.11'],
    ['>= 3.12.1', '3.12'],
    ['3.13', '3.13'],
    [undefined, '3.11'],
    ['garbage', '3.11']
  ])('%s -> %s', (spec, label) => {
    const floor = tc.parseFloor(spec as string | undefined)
    expect(floor.kind).toBe('semver')
    expect(floor.label).toBe(label)
  })

  it('names the language in its version label', () => {
    expect(tc.versionLabel(tc.parseFloor('>=3.12'))).toBe('Python 3.12')
  })

  it('suggests a Homebrew formula that matches the floor', () => {
    expect(tc.installHint(tc.parseFloor('>=3.12'))[0]).toBe('brew install python@3.12')
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
      base: { PATH: '/usr/bin:/bin' },
      pathDirs: [provision.binDir('/w/course/.venv'), '/opt/homebrew/bin'],
      extra: tc.extraEnv({ envDir: '/w/course/.venv' })
    })
    expect(env['PATH']).toBe('/w/course/.venv/bin:/opt/homebrew/bin:/usr/bin:/bin')
    expect(env['VIRTUAL_ENV']).toBe('/w/course/.venv')
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
