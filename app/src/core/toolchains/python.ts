/**
 * The Python toolchain: a per-course virtualenv built from the system
 * interpreter, and pytest.
 *
 * Nothing is bundled - the interpreter comes from the learner's machine, which
 * is why discovery probes absolute paths a GUI process could never reach
 * through PATH.
 */
import { safeFlags, tokenizeCommand } from './argv'
import type { PlanContext, TestPlan, Toolchain, VersionFloor } from './types'

/** Interpreter basenames, newest first. */
export const PYTHON_NAMES = ['python3.14', 'python3.13', 'python3.12', 'python3.11'] as const

/**
 * Bare names are a last resort. On a Finder-launched app PATH is launchd's
 * minimal one, where `python3` is the Command Line Tools shim: it is 3.9.6 (so
 * it fails every course floor anyway) and invoking it without CLT installed
 * pops Apple's developer-tools dialog attributed to *this* app.
 */
export const PYTHON_FALLBACK_NAMES = ['python3', 'python'] as const

export const DEFAULT_TEST_COMMAND = 'pytest -q'
export const BASE_REQUIREMENTS = ['pytest>=8']

const DEFAULT_FLOOR: [number, number] = [3, 11]

/** Directories worth probing directly, highest priority first. */
export function pythonSearchDirs(home: string): string[] {
  const frameworks = PYTHON_NAMES.map(
    (name) => `/Library/Frameworks/Python.framework/Versions/${name.replace('python', '')}/bin`
  )
  return ['/opt/homebrew/bin', '/usr/local/bin', ...frameworks, `${home}/.pyenv/shims`, `${home}/.local/bin`]
}

export function venvBinDir(envDir: string): string {
  return `${envDir}/bin`
}

export function venvPython(envDir: string): string {
  return `${envDir}/bin/python`
}

function semver(floor: VersionFloor): [number, number] {
  return floor.kind === 'semver' ? [floor.major, floor.minor] : DEFAULT_FLOOR
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
    names: PYTHON_NAMES,
    fallbackNames: PYTHON_FALLBACK_NAMES,
    searchDirs: pythonSearchDirs,
    probeArgs(floor) {
      const [major, minor] = semver(floor)
      return ['-c', `import sys; sys.exit(0 if sys.version_info[:2] >= (${major}, ${minor}) else 1)`]
    },
    versionArgs: ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
    needsCommandLineTools: true
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

  /** ">=3.11" / "3.12" / ">= 3.11.2" -> [3, 11]. Falls back to 3.11. */
  parseFloor(spec) {
    const m = /(\d+)\.(\d+)/.exec(spec ?? '')
    const [major, minor] = m ? [Number(m[1]), Number(m[2])] : DEFAULT_FLOOR
    return { kind: 'semver', major, minor, label: `${major}.${minor}` }
  },

  versionLabel(floor) {
    return `${this.label} ${floor.label}`
  },

  installHint(floor) {
    const [major, minor] = semver(floor)
    return [`brew install python@${major}.${minor}`, 'or download it from https://www.python.org/downloads/']
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
      ...(envDir ? { VIRTUAL_ENV: envDir, PYTHONHOME: null } : {})
    }
  },

  plan(ctx: PlanContext): TestPlan {
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
