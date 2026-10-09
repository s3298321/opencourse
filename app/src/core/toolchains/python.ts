/** Python exercises use the interpreter shipped with OpenCourse and a local course venv. */
import { safeFlags, tokenizeCommand } from './argv'
import type { PlanContext, TestPlan, Toolchain } from './types'

export const DEFAULT_TEST_COMMAND = 'pytest -q'
export const BASE_REQUIREMENTS = ['pytest>=8']
export const PYTHON_MINIMUM_PATTERN = /^(?:>=\s*)?(\d+)\.(\d+)(?:\.(\d+))?$/

export function validPythonMinimum(spec: string): boolean {
  return PYTHON_MINIMUM_PATTERN.test(spec.trim())
}

export function venvBinDir(envDir: string): string {
  return `${envDir}/bin`
}

export function venvPython(envDir: string): string {
  return `${envDir}/bin/python`
}

export const pythonToolchain: Toolchain = {
  id: 'python',
  label: 'Python',
  highlight: 'python',
  indentUnit: '    ',

  layout: {
    learnerFile: 'exercise.py',
    testFile: 'test_exercise.py',
    solutionFile: 'solution.py',
    depsFile: 'requirements.txt',
    envDirName: '.venv',
    emptyStarter: '# your code here\n',
    staleArtifacts: ['__pycache__', '.pytest_cache']
  },

  discovery: {
    names: [],
    fallbackNames: [],
    searchDirs: () => [],
    probeArgs(floor) {
      const { major, minor, patch = 0 } = floor.kind === 'semver' ? floor : { major: 3, minor: 11 }
      return ['-c', `import sys; sys.exit(0 if sys.version_info[:3] >= (${major}, ${minor}, ${patch}) else 1)`]
    },
    versionArgs: ['-c', 'import sys, ssl, sqlite3, ctypes, venv, ensurepip; print("%d.%d.%d" % sys.version_info[:3])'],
    needsCommandLineTools: false
  },

  provision: {
    create: (envDir) => ['-m', 'venv', '--clear', envDir],
    exe: venvPython,
    binDir: venvBinDir,
    health: ['-c', 'import sys; sys.exit(0)'],
    install: (depsPath) => ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', depsPath],
    warm: ['-c', 'import pytest'],
    baseDeps: BASE_REQUIREMENTS,
    stampFile: '.opencourse-requirements'
  },

  /** A bare version is a minimum, never an interpreter selector. */
  parseFloor(spec) {
    const m = PYTHON_MINIMUM_PATTERN.exec((spec ?? '>=3.11').trim())
    if (!m) throw new Error('Minimum Python version must be MAJOR.MINOR[.PATCH] or >=MAJOR.MINOR[.PATCH].')
    const major = Number(m[1]), minor = Number(m[2])
    const patch = m[3] === undefined ? undefined : Number(m[3])
    return { kind: 'semver', major, minor, ...(patch === undefined ? {} : { patch }), label: `${major}.${minor}${patch === undefined ? '' : `.${patch}`}` }
  },

  versionLabel(floor) {
    return `${this.label} ${floor.label}`
  },

  installHint() {
    return ['Update OpenCourse to get a newer bundled Python. If the runtime is missing or damaged, reinstall OpenCourse.']
  },

  /**
   * A Finder-launched app has no LANG, which degrades Python's stdout encoding
   * and garbles pytest's box drawing (that default is generic and lives in
   * childEnv). PYTHONDONTWRITEBYTECODE stops a stale __pycache__ from making a
   * failing exercise look like it passes.
   */
  extraEnv({ envDir }) {
    return {
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PY_COLORS: '1',
      PYTHONHOME: null,
      PYTHONPATH: null,
      PYTHONNOUSERSITE: '1',
      VIRTUAL_ENV: envDir ?? null
    }
  },

  plan(ctx: PlanContext): TestPlan {
    if (ctx.runtime.language !== 'python') return { kind: 'unsupported', command: '', reason: 'Only Python exercises are supported' }
    const flags = safeFlags(ctx.runtime.flags)
    if (!flags.ok) return { kind: 'unsupported', command: ctx.runtime.flags.join(' '), reason: flags.reason }

    // No test file: the course states the expected output instead, and the
    // learner's own program is what gets run.
    if (!ctx.hasTests) {
      if (ctx.expectedOutput === undefined) {
        return { kind: 'unsupported', command: '', reason: 'the exercise has no tests and no expected output' }
      }
      return {
        kind: 'ok',
        steps: [
          {
            label: 'run',
            argv: [ctx.tool, ctx.layout.learnerFile],
            stdin: ctx.stdin,
            expect: { stdout: ctx.expectedOutput, match: ctx.match }
          }
        ]
      }
    }

    const command = ctx.testCommand ?? DEFAULT_TEST_COMMAND
    const parsed = tokenizeCommand(command)
    if (!parsed.ok) return { kind: 'unsupported', command, reason: parsed.reason }
    const { tokens } = parsed
    if (tokens[0] !== 'pytest') {
      return { kind: 'unsupported', command, reason: `only pytest runs in-app, got ${tokens[0]}` }
    }

    // `-p no:cacheprovider` keeps .pytest_cache out of the learner's folder.
    const argv = [ctx.tool, '-m', ...tokens]
    if (!tokens.includes('no:cacheprovider')) argv.push('-p', 'no:cacheprovider')
    return { kind: 'ok', steps: [{ label: 'checks', argv }] }
  },

  displayCommand(ctx) {
    if (!ctx.hasTests) return `python ${ctx.layout.learnerFile}`
    return ctx.testCommand ?? DEFAULT_TEST_COMMAND
  }
}
