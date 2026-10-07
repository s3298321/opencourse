/**
 * The LLVM IR toolchain: the learner writes textual IR, and clang compiles it.
 *
 * Nothing to install, again: every clang reads `.ll` files, and the one in the
 * Xcode Command Line Tools is a full LLVM back end. That is what makes IR a
 * language a course can grade - the learner's `exercise.ll` is compiled to an
 * object, linked against a C test harness that calls the functions it defines,
 * and the harness's exit code is the verdict, exactly as for C.
 *
 * Two exercise shapes, mirroring C:
 *
 *   unit     the course ships `test_exercise.c` with its own `main()`; the
 *            learner's IR defines the functions it calls.
 *   program  the course states `expected_output`; the learner's IR defines
 *            `@main` and its stdout is compared.
 *
 * Why a separate compile step for the IR, rather than one clang invocation for
 * both files: a release clang does not run the IR verifier on its input. A
 * phi with a missing predecessor, or a use that its definition does not
 * dominate, compiles silently into a binary that does something arbitrary - and
 * those are precisely the mistakes a learner of IR makes. The compile step
 * turns the verifier on, and keeps its report apart from the harness's.
 */
import { safeFlags, safeLibs } from './argv'
import type { PlanContext, ScaffoldContext, TestPlan, Toolchain, VersionFloor } from './types'

/** gcc is absent on purpose: it cannot read IR. `cc` is clang on macOS. */
export const LLVM_IR_COMPILER_NAMES = ['cc', 'clang'] as const

const BUILD_DIR = '.opencourse-build'
const OBJECT = 'exercise.o'
const BINARY = 'check'

/** The C standard the course's test harness is compiled with. */
const HARNESS_STD = 'c17'

/**
 * Appended after the course's own flags, so a course cannot switch them off.
 *
 * `-fverify-intermediate-code` is the whole reason for the separate step (see
 * above). `-fno-crash-diagnostics` because a verifier failure is reported as a
 * backend fatal error, and clang would otherwise follow it with a "PLEASE
 * ATTACH THE FOLLOWING FILES" banner and write reproducer files to the temp
 * directory - for what is an ordinary mistake in the learner's file.
 * `-Wno-override-module` because a hand-written module rarely names a target,
 * and clang warning that it supplied the host's is noise.
 */
const IR_FLAGS = ['-fverify-intermediate-code', '-fno-crash-diagnostics', '-Wno-override-module']

/** The fixed floor: what the probe checks is a capability, not a version. */
const FLOOR: VersionFloor = { kind: 'std', std: 'llvm-ir', label: 'LLVM IR' }

function compileIr(opts: { flags: readonly string[]; out: string; source: string }): string[] {
  return ['-fcolor-diagnostics', ...opts.flags, ...IR_FLAGS, '-c', '-o', opts.out, opts.source]
}

function link(opts: {
  flags: readonly string[]
  libs: readonly string[]
  out: string
  object: string
  harness?: string
}): string[] {
  return opts.harness
    ? [`-std=${HARNESS_STD}`, '-fcolor-diagnostics', ...opts.flags, '-o', opts.out, opts.object, opts.harness, ...opts.libs]
    : ['-fcolor-diagnostics', ...opts.flags, '-o', opts.out, opts.object, ...opts.libs]
}

export const llvmIrToolchain: Toolchain = {
  id: 'llvm-ir',
  label: 'LLVM IR',
  highlight: 'llvm',
  indentUnit: '  ',

  layout: {
    learnerFile: 'exercise.ll',
    testFile: 'test_exercise.c',
    solutionFile: 'solution.ll',
    buildDirName: BUILD_DIR,
    emptyStarter: '; your code here\n',
    // An object or binary left over from the previous edit would link and pass.
    staleArtifacts: [BUILD_DIR]
  },

  discovery: {
    names: LLVM_IR_COMPILER_NAMES,
    fallbackNames: [],
    // /usr/bin first, gated on the Command Line Tools as for C. Homebrew's llvm
    // is keg-only, so its clang is never on a PATH and is probed absolutely:
    // it is the way in for a machine whose Command Line Tools predate the
    // verifier flag.
    searchDirs: () => [
      '/usr/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/homebrew/opt/llvm/bin',
      '/usr/local/opt/llvm/bin'
    ],
    /**
     * Compiles a module from stdin with the exact flags a run uses. That proves
     * the compiler reads IR at all (gcc does not), reads opaque pointers, and
     * accepts the verifier flag - which older clangs reject as unknown.
     */
    probeArgs: () => ['-x', 'ir', ...IR_FLAGS, '-c', '-o', '/dev/null', '-'],
    probeInput: () => 'define i32 @probe(ptr %p) {\n  %v = load i32, ptr %p\n  ret i32 %v\n}\n',
    versionArgs: ['--version'],
    needsCommandLineTools: true
  },

  /** No provision block: the system compiler is the environment. */

  /** `runtime.version` means nothing here; see FLOOR. Never throws. */
  parseFloor() {
    return FLOOR
  },

  versionLabel(floor) {
    return floor.label
  },

  installHint() {
    return ['xcode-select --install', 'or brew install llvm']
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

    const object = `${ctx.exerciseDir}/${BUILD_DIR}/${OBJECT}`
    const binary = `${ctx.exerciseDir}/${BUILD_DIR}/${BINARY}`

    const compile = compileIr({ flags: flags.flags, out: object, source: ctx.layout.learnerFile })
    const linked = link({
      flags: flags.flags,
      libs: libs.args,
      out: binary,
      object,
      harness: ctx.hasTests ? ctx.layout.testFile : undefined
    })

    // As for C: with a test main the exit code is the whole verdict.
    const run =
      ctx.hasTests || ctx.expectedOutput === undefined
        ? { label: 'run', argv: [binary], stdin: ctx.stdin }
        : {
            label: 'run',
            argv: [binary],
            stdin: ctx.stdin,
            expect: { stdout: ctx.expectedOutput, match: ctx.match }
          }

    return {
      kind: 'ok',
      steps: [
        { label: 'compile', argv: [ctx.tool, ...compile] },
        { label: 'link', argv: [ctx.tool, ...linked] },
        run
      ]
    }
  },

  displayCommand(ctx: ScaffoldContext) {
    const object = `${BUILD_DIR}/${OBJECT}`
    const strip = (args: string[]): string => args.filter((arg) => arg !== '-fcolor-diagnostics').join(' ')
    const compile = compileIr({ flags: ctx.runtime.flags, out: object, source: ctx.layout.learnerFile })
    const linked = link({
      flags: ctx.runtime.flags,
      libs: ctx.runtime.packages.map((name) => `-l${name}`),
      out: `${BUILD_DIR}/${BINARY}`,
      object,
      harness: ctx.hasTests ? ctx.layout.testFile : undefined
    })
    return `cc ${strip(compile)} && cc ${strip(linked)} && ./${BUILD_DIR}/${BINARY}`
  }
}
