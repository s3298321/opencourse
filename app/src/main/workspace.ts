import { assertCourseAvailable } from './course-busy'
/**
 * The exercise workspace: scaffold a folder, and read and write the learner's
 * file.
 *
 * The file on disk is the single source of truth. The in-app editor writes it,
 * but so can anything else on the machine - the editor's own Terminal tab, or
 * another editor pointed at the folder - hence the mtime conflict check below.
 * Which file that is comes from the exercise's toolchain, never from a literal
 * here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { shell } from 'electron'
import { applyScaffold, planScaffold, type ScaffoldPlan } from '../core/scaffold'
import { exerciseLanguage, getToolchain, resolveRuntime } from '../core/toolchains'
import type { ResolvedRuntime, Toolchain } from '../core/toolchains/types'
import type { Course, ExerciseBlock, ExerciseSession, ExerciseTarget, WriteResult } from '../core/types'
import { getCourse } from './courses'
import { userWorkspaceRoot } from './paths'
import { requireUser } from './users'

/** Guards against a runaway renderer writing an unbounded file. */
const MAX_EXERCISE_BYTES = 1024 * 1024

export type ScaffoldRequest = ExerciseTarget

/**
 * The deps file is course-level, so it must cover every exercise in the course
 * that shares this toolchain. Exercises in another language contribute nothing:
 * a C exercise's `-lm` has no business in requirements.txt.
 */
function coursePackages(course: Course, language: string): string[] {
  const packages = new Set<string>()
  for (const mod of course.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        if (block.type !== 'exercise') continue
        if (exerciseLanguage(course, block) !== language) continue
        for (const pkg of resolveRuntime(course, block).packages) packages.add(pkg)
      }
    }
  }
  return [...packages]
}

interface Resolved {
  course: Course
  exercise: ExerciseBlock
  lessonTitle: string
  courseTitle: string
  toolchain: Toolchain
  runtime: ResolvedRuntime
}

function findExercise(req: ScaffoldRequest): Resolved {
  assertCourseAvailable(req.courseId)
  const course = getCourse(req.courseId)
  if (!course) throw new Error(`unknown course: ${req.courseId}`)
  const lessons = course.modules.flatMap((m) => m.type === 'project' ? [] : m.lessons)
  const lesson = lessons.find((l) => l.blocks.some((b) => b.type === 'exercise' && b.id === req.blockId))
  const exercise = lesson?.blocks.find((b) => b.type === 'exercise' && b.id === req.blockId) as ExerciseBlock | undefined
  if (!lesson || !exercise) throw new Error(`unknown exercise: ${req.blockId}`)
  const runtime = resolveRuntime(course, exercise)
  return {
    course,
    exercise,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    toolchain: getToolchain(runtime.language),
    runtime
  }
}

/**
 * The renderer never sends a path - only manifest ids, which planScaffold has
 * already run through assertSafeSegment. Containment is structural rather than
 * validated after the fact.
 */
function planFor(req: ScaffoldRequest): { plan: ScaffoldPlan; resolved: Resolved } {
  const resolved = findExercise(req)
  const plan = planScaffold({ workspaceRoot: userWorkspaceRoot(requireUser()), ...req }, resolved.exercise, {
    courseTitle: resolved.courseTitle,
    lessonTitle: resolved.lessonTitle,
    toolchain: resolved.toolchain,
    runtime: resolved.runtime,
    coursePackages: coursePackages(resolved.course, resolved.toolchain.id)
  })
  return { plan, resolved }
}

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (mode !== undefined) chmodSync(path, mode)
}

export function revealInFinder(path: string): void {
  shell.showItemInFolder(path)
}

/* -------------------------------------------------------------------------- */
/* the learner's file                                                          */
/* -------------------------------------------------------------------------- */

function readFileState(path: string): { content: string; mtimeMs: number } {
  return { content: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }
}

/**
 * Opens an exercise for editing: scaffolds (never clobbering the learner's file)
 * and hands back their current text plus everything the runner needs.
 */
export function openExercise(req: ScaffoldRequest): ExerciseSession {
  const { plan, resolved } = planFor(req)
  applyScaffold(plan, { exists: existsSync, write })
  const { content, mtimeMs } = readFileState(plan.learnerPath)
  return {
    exerciseDir: plan.exerciseDir,
    courseDir: plan.courseDir,
    language: resolved.toolchain.id,
    languageLabel: resolved.toolchain.label,
    indentUnit: resolved.toolchain.indentUnit,
    learnerFile: plan.layout.learnerFile,
    envDir: plan.envDir,
    depsPath: plan.depsPath,
    testCommand: plan.testCommand,
    hasTests: plan.hasTests,
    canRun: plan.canRun,
    content,
    mtimeMs
  }
}

/** Everything the runner needs that never crosses the IPC boundary. */
export function runContextFor(req: ScaffoldRequest): {
  plan: ScaffoldPlan
  toolchain: Toolchain
  runtime: ResolvedRuntime
  exercise: ExerciseBlock
} {
  const { plan, resolved } = planFor(req)
  applyScaffold(plan, { exists: existsSync, write })
  return { plan, toolchain: resolved.toolchain, runtime: resolved.runtime, exercise: resolved.exercise }
}

export function readExerciseFile(req: ScaffoldRequest): { content: string; mtimeMs: number } {
  const { plan } = planFor(req)
  return readFileState(plan.learnerPath)
}

/**
 * Writes the learner's file, refusing when it changed underneath us - the
 * learner may well have the same file open in Terminal.app. `expectedMtimeMs`
 * of null means "overwrite regardless", which is what the conflict banner's
 * Overwrite button sends.
 */
export function writeExerciseFile(
  req: ScaffoldRequest,
  content: string,
  expectedMtimeMs: number | null
): WriteResult {
  if (Buffer.byteLength(content, 'utf8') > MAX_EXERCISE_BYTES) return { ok: false, reason: 'too-large' }

  const { plan } = planFor(req)
  const path = plan.learnerPath

  if (expectedMtimeMs !== null && existsSync(path)) {
    const current = statSync(path).mtimeMs
    if (Math.abs(current - expectedMtimeMs) > 1) {
      return { ok: false, reason: 'conflict', ...readFileState(path) }
    }
  }

  // Atomic, like the progress writer: a half-written file would be
  // indistinguishable from the learner having deleted their work.
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
  return { ok: true, mtimeMs: statSync(path).mtimeMs }
}
