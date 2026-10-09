import { describe, expect, it } from 'vitest'
import { applyScaffold, assertSafeRelativePath, assertSafeSegment, depsFor, planScaffold } from '@core/scaffold'
import { pythonToolchain } from '@core/toolchains'
import type { ScaffoldContextInput } from '@core/scaffold'
import type { ExerciseBlock } from '@core/types'

const exercise: ExerciseBlock = {
  type: 'exercise', slug: 'ex-tasks-1',
  id: 'ex-tasks-1',
  title: 'Parallelize three coroutines',
  prompt: 'Make it concurrent.',
  starter_code: 'async def main(): ...\n',
  solution: 'async def main(): return 1\n',
  tests: 'def test_x(): assert True\n',
  verification_instructions: 'Run pytest.',
  hints: ['use gather']
}

const target = {
  workspaceRoot: '/Users/me/opencourse',
  courseId: 'python-asyncio',
  moduleId: 'coroutines-and-tasks',
  lessonId: 'await-and-tasks',
  blockId: 'ex-tasks-1'
}

function ctx(overrides: Partial<ScaffoldContextInput> = {}): ScaffoldContextInput {
  return {
    courseTitle: 'Async',
    lessonTitle: 'await and tasks',
    toolchain: pythonToolchain,
    runtime: { language: 'python', version: '>=3.11', packages: [], flags: [] },
    ...overrides
  }
}

describe('paths', () => {
  const plan = planScaffold(target, exercise, ctx())

  it('nests the exercise under its stable course and block IDs', () => {
    expect(plan.exerciseDir).toBe(
      '/Users/me/opencourse/python-asyncio/exercises/ex-tasks-1'
    )
    expect(plan.envDir).toBe('/Users/me/opencourse/python-asyncio/.venv')
    expect(plan.learnerPath).toBe(`${plan.exerciseDir}/exercise.py`)
  })

  it('refuses path segments that would escape the workspace', () => {
    for (const bad of ['..', '../etc', 'a/b', '.', '', '/abs', '~root']) {
      expect(() => planScaffold({ ...target, blockId: bad }, exercise, ctx()), bad).toThrow()
      expect(() => planScaffold({ ...target, courseId: bad }, exercise, ctx()), bad).toThrow()
    }
  })


})

describe('files', () => {
  const plan = planScaffold(target, exercise, ctx())
  const byName = (name: string): string | undefined =>
    [...plan.files, ...plan.preserveFiles].find((f) => f.path.endsWith(name))?.content

  it('writes tests, solution, README and requirements', () => {
    expect(byName('test_exercise.py')).toBe(exercise.tests)
    expect(byName('solution.py')).toBe(exercise.solution)
    expect(byName('README.md')).toContain('Parallelize three coroutines')
    expect(byName('requirements.txt')).toContain('pytest')
  })

  it('names the learner file in the README, whatever it is called', () => {
    expect(byName('README.md')).toContain('`exercise.py`')
    const c = planScaffold(target, { ...exercise, tests: 'int main(void){return 0;}' }, ctx())
    const readme = c.files.find((f) => f.path.endsWith('README.md'))?.content ?? ''
    expect(readme).toContain('`exercise.py`')
  })

  it('puts the starter in the never-overwrite list', () => {
    expect(plan.preserveFiles.map((f) => f.path.split('/').pop())).toEqual(['exercise.py'])
    const names = plan.files.map((f) => f.path.split('/').pop())
    expect(names).not.toContain('exercise.py')
  })

  it('writes nothing that opens Terminal.app', () => {
    // The built-in editor is the only way into an exercise. A `.command` in the
    // folder would be a second one, and one macOS runs on a double-click.
    const c = planScaffold(target, { ...exercise, tests: 'int main(void){return 0;}' }, ctx())
    for (const p of [plan, c]) {
      expect(p.files.some((f) => f.path.endsWith('.command'))).toBe(false)
      expect(p.files.some((f) => f.mode !== undefined)).toBe(false)
    }
  })

  it('omits solution and tests when the exercise has none', () => {
    const bare = planScaffold(target, { ...exercise, solution: undefined, tests: undefined }, ctx())
    expect(bare.files.some((f) => f.path.endsWith('solution.py'))).toBe(false)
    expect(bare.files.some((f) => f.path.endsWith('test_exercise.py'))).toBe(false)
    expect(bare.hasTests).toBe(false)
    expect(bare.canRun).toBe(false)
  })

  it('can be verified by expected output instead of a test file', () => {
    const io = planScaffold(target, { ...exercise, tests: undefined, expected_output: 'ok\n' }, ctx())
    expect(io.hasTests).toBe(false)
    expect(io.canRun).toBe(true)
  })

  it('uses the toolchain empty starter when the course ships none', () => {
    const py = planScaffold(target, { ...exercise, starter_code: undefined }, ctx())
    expect(py.preserveFiles[0]?.content).toBe('# your code here\n')
    const c = planScaffold(target, { ...exercise, starter_code: undefined, tests: 'x' }, ctx())
    expect(c.preserveFiles[0]?.content).toBe('# your code here\n')
  })
})

describe('extra_files', () => {
  const withHeader: ExerciseBlock = {
    ...exercise,
    tests: 'import exercise\n',
    extra_files: [
      { path: 'support.py', content: 'VALUE = 3\n' },
      { path: 'fixtures/data.txt', content: '1 2 3\n' }
    ]
  }

  it('regenerates them, so a learner cannot break them permanently', () => {
    const plan = planScaffold(target, withHeader, ctx())
    const names = plan.files.map((f) => f.path.replace(`${plan.exerciseDir}/`, ''))
    expect(names).toContain('support.py')
    expect(names).toContain('fixtures/data.txt')
    expect(plan.preserveFiles.map((f) => f.path.split('/').pop())).toEqual(['exercise.py'])
  })

  it('lists them in the README so the learner knows what is provided', () => {
    const plan = planScaffold(target, withHeader, ctx())
    expect(plan.files.find((f) => f.path.endsWith('README.md'))?.content).toContain('`support.py`')
  })

  it('refuses a path that would write outside the exercise', () => {
    for (const bad of ['../evil.h', '/etc/passwd', 'a/../../b', '~/.zshrc', '.hidden', 'evil.command']) {
      expect(
        () => planScaffold(target, { ...withHeader, extra_files: [{ path: bad, content: 'x' }] }, ctx()),
        bad
      ).toThrow()
    }
  })
})

describe('depsFor', () => {
  it('adds exercise-specific packages to the base requirements', () => {
    const deps = depsFor({ language: 'python', packages: ['pytest-asyncio'], flags: [] }, ['pytest>=8'])
    expect(deps).toContain('pytest-asyncio')
    expect(deps).toContain('pytest>=8')
  })

  it('covers the whole course, so switching exercises does not reinstall', () => {
    const deps = depsFor({ language: 'python', packages: ['httpx'], flags: [] }, ['pytest>=8'], [
      'pytest-asyncio',
      'httpx'
    ])
    expect(deps).toContain('httpx')
    expect(deps).toContain('pytest-asyncio')
    // A duplicate would make the install stamp differ from itself.
    expect(deps.split('\n').filter((line) => line === 'httpx')).toHaveLength(1)
  })
})

describe('the test command', () => {
  it('honours a custom one', () => {
    const custom = planScaffold(target, { ...exercise, test_command: 'pytest -x -q' }, ctx())
    expect(custom.testCommand).toBe('pytest -x -q')
  })
})

describe('assertSafeSegment', () => {
  it('accepts normal slugs and ids', () => {
    for (const ok of ['python-asyncio', 'ex-tasks-1', 'a', 'A1_b.c']) {
      expect(assertSafeSegment(ok, 'test')).toBe(ok)
    }
  })

  it('accepts a nested relative path but nothing that climbs out', () => {
    expect(assertSafeRelativePath('fixtures/data.txt', 'test')).toBe('fixtures/data.txt')
    expect(() => assertSafeRelativePath('../x', 'test')).toThrow()
  })
})

describe('applyScaffold', () => {
  const plan = planScaffold(target, exercise, ctx())

  function fakeFs(existing: Record<string, string> = {}): {
    files: Record<string, string>
    fs: { exists: (p: string) => boolean; write: (p: string, c: string) => void }
  } {
    const files = { ...existing }
    return {
      files,
      fs: {
        exists: (p) => p in files,
        write: (p, c) => {
          files[p] = c
        }
      }
    }
  }

  it('writes everything on a fresh directory', () => {
    const { files, fs } = fakeFs()
    applyScaffold(plan, fs)
    const names = Object.keys(files).map((p) => p.split('/').pop())
    expect(names).toEqual(
      expect.arrayContaining(['requirements.txt', 'README.md', 'test_exercise.py', 'solution.py', 'exercise.py'])
    )
    expect(names).not.toContain('run.command')
  })

  it('never overwrites the learner’s own file', () => {
    const mine = plan.preserveFiles[0]!.path
    const { files, fs } = fakeFs({ [mine]: '# three hours of my work\n' })
    applyScaffold(plan, fs)
    expect(files[mine]).toBe('# three hours of my work\n')
  })

  it('does refresh the tests and the runner', () => {
    const testPath = plan.files.find((f) => f.path.endsWith('test_exercise.py'))!.path
    const { files, fs } = fakeFs({ [testPath]: 'stale' })
    applyScaffold(plan, fs)
    expect(files[testPath]).toBe(exercise.tests)
  })
})
