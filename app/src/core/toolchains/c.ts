/**
 * The C toolchain: the system compiler, and nothing else.
 *
 * There is no per-course environment to build - `cc` from the Xcode Command
 * Line Tools is the environment, and libc brings `assert.h`, which is all an
 * intro course needs. That is deliberate: no download, no package manager, and
 * a failing assertion already exits non-zero, which is the grading contract the
 * app has always had.
 *
 * Two exercise shapes, both planned here:
 *
 *   unit     the course ships `test_exercise.c` with its own `main()`; the
 *            learner writes functions in `exercise.c`. Both translation units
 *            are compiled together and the binary's exit code is the verdict.
 *   program  the course states `expected_output` instead; the learner writes a
 *            whole program and its stdout is compared. This is the only shape
 *            that works for the first lesson of a C course, where "write a
 *            program that prints X" *is* the exercise.
 */
import { safeFlags, safeLibs } from './argv'
import type { PlanContext, ScaffoldContext, TestPlan, Toolchain, VersionFloor } from './types'

/**
 * `cc` first: it is the CLT shim and therefore whatever compiler the user
 * actually has. A Homebrew gcc is a deliberate second choice.
 */
export const C_COMPILER_NAMES = ['cc', 'clang', 'gcc'] as const

/**
 * A warning for course authors, verified the hard way: an `-fsanitize=address`
 * binary built by Apple clang 17 on macOS 26 *hangs at startup* - no output, no
 * crash, 0% CPU until the watchdog kills it. UBSan is fine, and
 * `-fsanitize=undefined -fno-sanitize-recover=all` aborts with a readable
 * runtime error and a non-zero exit, which is exactly what grading wants. Grade
 * memory bugs with UBSan and with allocation accounting the course provides in
 * a header - never with ASan.
 */

export const DEFAULT_STD = 'c17'

/** Standards clang and gcc both understand. Anything else falls back. */
const KNOWN_STDS = /\b(?:gnu|c)(?:89|90|94|99|11|17|18|23)\b/i

const BUILD_DIR = '.opencourse-build'
const BINARY = 'check'

function std(floor: VersionFloor): string {
  return floor.kind === 'std' ? floor.std : DEFAULT_STD
}

/**
 * Colour diagnostics are app-supplied rather than author-supplied: output is
 * piped, so clang would otherwise decide it is not a terminal and emit a wall
 * of monochrome text into a pane that can render colour perfectly well.
 */
function compileArgs(opts: {
  std: string
  flags: readonly string[]
  libs: readonly string[]
  out: string
  sources: readonly string[]
}): string[] {
  return [
    `-std=${opts.std}`,
    '-fcolor-diagnostics',
    ...opts.flags,
    '-o',
    opts.out,
    ...opts.sources,
    ...opts.libs
  ]
}

function sourcesFor(ctx: PlanContext | ScaffoldContext): string[] {
  return ctx.hasTests ? [ctx.layout.learnerFile, ctx.layout.testFile] : [ctx.layout.learnerFile]
}

export const cToolchain: Toolchain = {
  id: 'c',
  label: 'C',
  highlight: 'c',
  indentUnit: '    ',

  layout: {
    learnerFile: 'exercise.c',
    testFile: 'test_exercise.c',
    solutionFile: 'solution.c',
    buildDirName: BUILD_DIR,
    emptyStarter: '/* your code here */\n',
    // A binary left over from the previous edit would run again and pass.
    staleArtifacts: [BUILD_DIR]
  },

  discovery: {
    names: C_COMPILER_NAMES,
    fallbackNames: [],
    // /usr/bin first, but findTool skips it until the Command Line Tools are
    // confirmed: /usr/bin/cc exists without them and invoking it pops Apple's
    // installer dialog attributed to this app.
    searchDirs: () => ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'],
    /**
     * Compiles an empty translation unit from stdin. This proves the compiler
     * runs *and* that it accepts the standard the course asked for, which a
     * version string cannot.
     */
    probeArgs: (floor) => ['-x', 'c', `-std=${std(floor)}`, '-fsyntax-only', '-'],
    probeInput: () => 'int main(void) { return 0; }\n',
    versionArgs: ['--version'],
    needsCommandLineTools: true
  },

  /** No provision block: there is no per-course environment to build. */

  /** ">=c17" / "c11" / "C99" -> that standard. Falls back to c17. */
  parseFloor(spec) {
    const m = KNOWN_STDS.exec(spec ?? '')
    const found = (m?.[0] ?? DEFAULT_STD).toLowerCase()
    return { kind: 'std', std: found, label: found.toUpperCase() }
  },

  /** "C17" already names the language; prefixing it again reads as "C C17". */
  versionLabel(floor) {
    return floor.label
  },

  installHint() {
    return ['xcode-select --install', 'or install Xcode from the App Store']
  },

  extraEnv() {
    return {}
  },

  plan(ctx: PlanContext): TestPlan {
    const flags = safeFlags(ctx.runtime.flags)
    if (!flags.ok) return { kind: 'unsupported', command: ctx.runtime.flags.join(' '), reason: flags.reason }
    const libs = safeLibs(ctx.runtime.packages)
    if (!libs.ok) return { kind: 'unsupported', command: ctx.runtime.packages.join(' '), reason: libs.reason }

    if (!ctx.hasTests && ctx.expectedOutput === undefined) {
      return { kind: 'unsupported', command: '', reason: 'the exercise has no tests and no expected output' }
    }

    const binary = `${ctx.exerciseDir}/${BUILD_DIR}/${BINARY}`
    const compile = compileArgs({
      std: std(this.parseFloor(ctx.runtime.version)),
      flags: flags.flags,
      libs: libs.args,
      out: binary,
      sources: sourcesFor(ctx)
    })

    // With a test main the exit code is the whole verdict; stdout is the test's
    // own reporting, so it is streamed but never compared.
    const run =
      ctx.hasTests || ctx.expectedOutput === undefined
        ? { label: 'run', argv: [binary], stdin: ctx.stdin }
        : {
            label: 'run',
            argv: [binary],
            stdin: ctx.stdin,
            expect: { stdout: ctx.expectedOutput, match: ctx.match }
          }

    return { kind: 'ok', steps: [{ label: 'compile', argv: [ctx.tool, ...compile] }, run] }
  },

  displayCommand(ctx) {
    const compile = compileArgs({
      std: std(this.parseFloor(ctx.runtime.version)),
      flags: ctx.runtime.flags,
      libs: ctx.runtime.packages.map((name) => `-l${name}`),
      out: `${BUILD_DIR}/${BINARY}`,
      sources: sourcesFor(ctx)
    }).filter((arg) => arg !== '-fcolor-diagnostics')
    return `cc ${compile.join(' ')} && ./${BUILD_DIR}/${BINARY}`
  }
}
