/**
 * The toolchain contract: everything one language needs in order to be a
 * first-class citizen of a course.
 *
 * Pure by contract - no fs, no child_process, no Electron, and no imports from
 * ../types, so a descriptor stays unit-testable and the module graph stays
 * acyclic. The side-effecting half (discovery, provisioning, running) lives in
 * src/main/toolchain.ts and consumes these descriptors without ever naming a
 * language.
 */

/**
 * How far back a course is willing to go. Toolchains disagree about what a
 * version even is - CPython has a release number, C has a language standard -
 * so the floor is a union and each descriptor narrows its own kind.
 */
export type VersionFloor =
  | { kind: 'semver'; major: number; minor: number; patch?: number; label: string }
  | { kind: 'std'; std: string; label: string }

/** How an expected-output contract is compared against what the program printed. */
export type OutputMatch = 'exact' | 'trimmed' | 'lines'

export interface OutputExpectation {
  stdout: string
  match: OutputMatch
}

/**
 * One process in a verification run. A single-step plan is the interpreted case
 * (`pytest -q`); a compiled language emits a build step and then a run step, so
 * compiler diagnostics land in the Checks pane where the learner reads them.
 */
export interface RunStep {
  /** Shown dim above the step's output: 'checks', 'compile', 'run'. */
  label: string
  argv: string[]
  /** Fed to the process on stdin and then closed. */
  stdin?: string
  /**
   * When set, the step's stdout is captured and compared, and a mismatch fails
   * the step even though it exited 0.
   */
  expect?: OutputExpectation
}

export type TestPlan =
  | { kind: 'ok'; steps: RunStep[] }
  | { kind: 'unsupported'; command: string; reason: string }

/** Where the scaffolder puts things, and what the runner has to clean up. */
export interface ToolchainLayout {
  /** The one file the learner edits. Never overwritten once it exists. */
  learnerFile: string
  /** The course's checks. Regenerated on every open. */
  testFile: string
  solutionFile: string
  /** Course-level dependency manifest, when the toolchain installs deps. */
  depsFile?: string
  /** Per-course environment directory name, when the toolchain needs one. */
  envDirName?: string
  /** Scratch directory for build output, relative to the exercise dir. */
  buildDirName?: string
  /** Written as the learner's file when the course ships no starter_code. */
  emptyStarter: string
  /**
   * Removed before every run, relative to the exercise dir. A stale artifact
   * that survives a failed edit can make a broken exercise look like it passes,
   * and a false pass writes progress.
   */
  staleArtifacts: string[]
}

export interface ToolDiscovery {
  /** Executable basenames, best first. */
  names: readonly string[]
  /**
   * Tried only once the Command Line Tools are known to be present - invoking a
   * bare name without them pops Apple's developer-tools dialog attributed to
   * this app.
   */
  fallbackNames: readonly string[]
  /** Directories worth probing absolutely; a GUI process has no shell PATH. */
  searchDirs(home: string): string[]
  /** argv that exits 0 exactly when the candidate satisfies the floor. */
  probeArgs(floor: VersionFloor): string[]
  /** Written to the probe's stdin, for a compiler that reads source from `-`. */
  probeInput?(floor: VersionFloor): string | undefined
  /** Prints the resolved version on stdout, for the UI. */
  versionArgs: string[]
  /** Whether a bare-name fallback needs the CLT check at all. */
  needsCommandLineTools: boolean
}

/**
 * How a per-course environment is built. A toolchain that omits this has
 * nothing to install: the system compiler is the environment.
 */
export interface ProvisionSpec {
  /** argv that creates the environment, run as the discovered tool. */
  create(envDir: string): string[]
  /** The environment's own primary executable. */
  exe(envDir: string): string
  /** Prepended to PATH for every child process. */
  binDir(envDir: string): string
  /** Run as exe(); exit 0 means the environment still works. */
  health: string[]
  /** argv that installs the course deps file, run as exe(). */
  install(depsPath: string): string[]
  /**
   * Run once after installing. A cold first import inside a fresh environment
   * can add enough latency to trip the loose wall-clock assertions the course
   * format asks exercises to use.
   */
  warm?: string[]
  /** Lines the deps file always contains, whatever the course asked for. */
  baseDeps: string[]
  /** Stamp file inside the environment recording what deps are installed. */
  stampFile: string
}

/** An author-declared runtime, before defaults are filled in. */
export interface RuntimeSpec {
  language?: string
  version?: string
  packages?: string[]
  flags?: string[]
}

/** A runtime with the course default applied and every field present. */
export interface ResolvedRuntime {
  language: string
  version?: string
  packages: string[]
  flags: string[]
}

/** Everything `plan` needs, with no filesystem access and no manifest types. */
export interface PlanContext {
  /** Absolute. Every step runs with this as its working directory. */
  exerciseDir: string
  /** The environment built for this course, when the toolchain has one. */
  envDir?: string
  /**
   * The resolved executable: the environment's own interpreter, or the system
   * compiler. Always absolute or a bare name already known to resolve.
   */
  tool: string
  runtime: ResolvedRuntime
  layout: ToolchainLayout
  /** The course shipped a test file for this exercise. */
  hasTests: boolean
  /** The author's explicit invocation, when the manifest set one. */
  testCommand?: string
  expectedOutput?: string
  stdin?: string
  match: OutputMatch
}

/** What the scaffolder and the UI need, with no tool resolved yet. */
export interface ScaffoldContext {
  exerciseDir: string
  courseDir: string
  envDir?: string
  depsPath?: string
  runtime: ResolvedRuntime
  layout: ToolchainLayout
  hasTests: boolean
  testCommand?: string
}

export interface Toolchain {
  /** Stable id; this is what a manifest's `runtime.language` names. */
  id: string
  /** For the UI: 'Python', 'C'. */
  label: string
  /** Shiki grammar and CodeMirror mode key. */
  highlight: string
  /**
   * One level of indentation in the editor, for a file that has none yet to
   * read it from. A file that does is the authority on its own style.
   */
  indentUnit: string
  layout: ToolchainLayout
  discovery: ToolDiscovery
  /** Absent means there is nothing to build per course. */
  provision?: ProvisionSpec

  /** Parse a validated minimum requirement. Invalid syntax throws; omission uses the default. */
  parseFloor(spec: string | undefined): VersionFloor
  /**
   * The complete human name of a floor: "Python 3.11", "C17". Only the
   * toolchain knows whether its version label already carries the language -
   * "C C17" was a real bug.
   */
  versionLabel(floor: VersionFloor): string
  /** Copy for the "could not find it" error: shell lines the user can run. */
  installHint(floor: VersionFloor): string[]
  /**
   * Extra environment for every child process. A null value unsets the
   * variable, which is how PYTHONHOME gets cleared for a virtualenv.
   */
  extraEnv(ctx: { envDir?: string }): Record<string, string | null>

  /** The ordered steps that verify one exercise. */
  plan(ctx: PlanContext): TestPlan
  /** What the README and the workbench show as "the command". Display only. */
  displayCommand(ctx: ScaffoldContext): string
}
