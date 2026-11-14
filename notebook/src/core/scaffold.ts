/**
 * Exercise workspace generation.
 *
 * Pure: the fs writes live in src/main/workspace.ts so this stays unit-testable.
 * Every filename comes from the toolchain's layout - nothing here knows that
 * Python exists.
 *
 * The app writes a self-contained folder the in-app editor and runner work in.
 * It used to add a `run.command` that opened the folder in Terminal.app; the
 * built-in editor is the only way in now, and its Terminal tab gets its
 * environment from main/pty.ts rather than from a generated script.
 */
import { outputMatch } from './toolchains'
import type { ResolvedRuntime, ScaffoldContext, Toolchain, ToolchainLayout } from './toolchains/types'
import type { ExerciseBlock } from './types'

export interface ScaffoldTarget {
  workspaceRoot: string
  courseId: string
  blockId: string
}

export interface ScaffoldPlan {
  courseDir: string
  exerciseDir: string
  language: string
  layout: ToolchainLayout
  /** Absent for a toolchain with nothing to install. */
  envDir?: string
  depsPath?: string
  /** The file the editor binds to. */
  learnerPath: string
  /** Written every time the learner asks for the exercise. */
  files: { path: string; content: string; mode?: number }[]
  /** Written only when absent, so learner edits are never clobbered. */
  preserveFiles: { path: string; content: string }[]
  /** Display only. Never executed. */
  testCommand: string
  hasTests: boolean
  /** Tests, or an expected-output contract: something the app can verify. */
  canRun: boolean
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Path segments come from the manifest, so treat them as untrusted input. */
export function assertSafeSegment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.includes('/')) {
    throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * An extra file may sit in a subdirectory, but every segment has to be a safe
 * one - which rules out '..', absolute paths and dotfiles by construction.
 * `.command` is refused outright: macOS runs one on double-click, and a course
 * must never be able to leave something in the workspace that does.
 */
export function assertSafeRelativePath(value: string, what: string): string {
  const segments = value.split('/')
  if (!segments.length) throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
  for (const segment of segments) assertSafeSegment(segment, what)
  if (value.toLowerCase().endsWith('.command')) {
    throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
  }
  return value
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

/**
 * The deps file is course-level, so it must cover every exercise in the course
 * that uses this toolchain. Writing only one exercise's packages made the
 * install stamp differ on every exercise switch, and that is a visible reinstall
 * each time.
 */
export function depsFor(runtime: ResolvedRuntime, baseDeps: string[], coursePackages: string[] = []): string {
  return [...new Set([...baseDeps, ...runtime.packages, ...coursePackages])].join('\n') + '\n'
}

export function readmeFor(
  exercise: ExerciseBlock,
  lessonTitle: string,
  testCommand: string,
  layout: ToolchainLayout,
  extraPaths: string[] = []
): string {
  const hints = (exercise.hints ?? []).map((h, i) => `${i + 1}. ${h}`).join('\n')
  return [
    `# ${exercise.title}`,
    '',
    `From the lesson: ${lessonTitle}`,
    '',
    '## Task',
    '',
    exercise.prompt,
    '',
    '## How to verify',
    '',
    exercise.verification_instructions,
    '',
    '```',
    testCommand,
    '```',
    '',
    ...(hints ? ['## Hints', '', hints, ''] : []),
    '## Files',
    '',
    `- \`${layout.learnerFile}\` — your work. Re-opening this exercise never overwrites it.`,
    ...(exercise.tests ? [`- \`${layout.testFile}\` — the checks. Regenerated from the course each time.`] : []),
    ...(exercise.solution ? [`- \`${layout.solutionFile}\` — one reference implementation.`] : []),
    ...extraPaths.map((path) => `- \`${path}\` — provided by the course. Regenerated each time.`),
    ''
  ].join('\n')
}

export interface ScaffoldContextInput {
  courseTitle: string
  lessonTitle: string
  toolchain: Toolchain
  runtime: ResolvedRuntime
  /** Every package every exercise in this course asks of this toolchain. */
  coursePackages?: string[]
}

export function planScaffold(
  target: ScaffoldTarget,
  exercise: ExerciseBlock,
  context: ScaffoldContextInput
): ScaffoldPlan {
  assertSafeSegment(target.courseId, 'course slug')
  assertSafeSegment(target.blockId, 'exercise id')

  const { toolchain, runtime } = context
  const layout = toolchain.layout

  const courseDir = join(target.workspaceRoot, target.courseId)
  const exerciseDir = join(courseDir, 'exercises', target.blockId)
  const envDir = layout.envDirName ? join(courseDir, layout.envDirName) : undefined
  const depsPath = layout.depsFile ? join(courseDir, layout.depsFile) : undefined
  const learnerPath = join(exerciseDir, layout.learnerFile)

  const hasTests = Boolean(exercise.tests)
  const canRun = hasTests || exercise.expected_output !== undefined

  const scaffoldContext: ScaffoldContext = {
    exerciseDir,
    courseDir,
    envDir,
    depsPath,
    runtime,
    layout,
    hasTests,
    testCommand: exercise.test_command
  }
  const testCommand = toolchain.displayCommand(scaffoldContext)

  const extraPaths = (exercise.extra_files ?? []).map((file) =>
    assertSafeRelativePath(file.path, 'extra file path')
  )

  const files: ScaffoldPlan['files'] = []
  if (depsPath && toolchain.provision) {
    files.push({
      path: depsPath,
      content: depsFor(runtime, toolchain.provision.baseDeps, context.coursePackages)
    })
  }
  files.push({
    path: join(exerciseDir, 'README.md'),
    content: readmeFor(exercise, context.lessonTitle, testCommand, layout, extraPaths)
  })
  if (exercise.tests) files.push({ path: join(exerciseDir, layout.testFile), content: exercise.tests })
  if (exercise.solution) files.push({ path: join(exerciseDir, layout.solutionFile), content: exercise.solution })
  for (const [i, file] of (exercise.extra_files ?? []).entries()) {
    files.push({ path: join(exerciseDir, extraPaths[i] as string), content: file.content })
  }

  const preserveFiles = [{ path: learnerPath, content: exercise.starter_code ?? layout.emptyStarter }]

  return {
    courseDir,
    exerciseDir,
    language: toolchain.id,
    layout,
    envDir,
    depsPath,
    learnerPath,
    files,
    preserveFiles,
    testCommand,
    hasTests,
    canRun
  }
}

export interface ScaffoldFs {
  exists(path: string): boolean
  write(path: string, content: string, mode?: number): void
}

/**
 * Writes a plan. Regenerated files are always rewritten; `preserveFiles` are
 * written only when absent, so a learner's edits are never clobbered.
 * Returns the paths that were actually written.
 */
export function applyScaffold(plan: ScaffoldPlan, fs: ScaffoldFs): string[] {
  const written: string[] = []
  for (const file of plan.files) {
    fs.write(file.path, file.content, file.mode)
    written.push(file.path)
  }
  for (const file of plan.preserveFiles) {
    if (fs.exists(file.path)) continue
    fs.write(file.path, file.content)
    written.push(file.path)
  }
  return written
}

export { outputMatch }
