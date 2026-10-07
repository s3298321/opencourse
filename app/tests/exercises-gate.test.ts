/**
 * The exercise gate: every solution passes its own checks, and every untouched
 * starter fails them - in whatever language the course is written in.
 *
 *   npm run check:exercises
 *
 * This replaces scripts/check-exercises.py, which reimplemented the app's
 * planning in Python and had already drifted out of step with it (it probed for
 * python3.13 while the app probed for 3.14). Everything below goes through the
 * same core/toolchains and core/scaffold code the workbench uses, so the gate
 * and the app cannot disagree by construction.
 *
 * Opt-in, because it builds real environments and runs real compilers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyScaffold, planScaffold } from '@core/scaffold'
import { getToolchain, outputMatch, resolveRuntime } from '@core/toolchains'
import type { Toolchain } from '@core/toolchains'
import type { CourseManifest, ExerciseBlock } from '@core/types'
import { ensureCourseEnv, runSteps } from '../src/main/toolchain'

const enabled = Boolean(process.env['OPENCOURSE_CHECK_EXERCISES'])
const only = process.env['OPENCOURSE_ONLY']

const REPO = join(__dirname, '..', '..')

interface Found {
  slug: string
  dir: string
  manifest: CourseManifest
  exercises: { moduleId: string; lessonId: string; lessonTitle: string; exercise: ExerciseBlock }[]
}

function courseDirs(): string[] {
  const contentDir = join(REPO, 'content')
  const dirs = existsSync(contentDir)
    ? readdirSync(contentDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => join(contentDir, e.name))
        .filter((dir) => existsSync(join(dir, 'course.json')))
    : []
  return [...dirs, join(REPO, 'docs', 'example-course')]
}

function load(dir: string): Found {
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
  const exercises: Found['exercises'] = []
  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons ?? []) {
      for (const block of lesson.blocks) {
        if (block.type !== 'exercise') continue
        if (only && block.id !== only) continue
        exercises.push({
          moduleId: mod.slug,
          lessonId: lesson.slug,
          lessonTitle: lesson.title,
          exercise: block
        })
      }
    }
  }
  return { slug: manifest.slug, dir, manifest, exercises }
}

const COURSES = enabled ? courseDirs().map(load) : []

/** One environment per (course, language), the way the app does it. */
const envs = new Map<string, Promise<string>>()

function toolFor(workspaceRoot: string, courseId: string, manifest: CourseManifest, toolchain: Toolchain, exercise: ExerciseBlock): Promise<string> {
  const courseDir = join(workspaceRoot, courseId)
  const key = `${courseDir}:${toolchain.id}`
  const existing = envs.get(key)
  if (existing) return existing

  const runtime = resolveRuntime(manifest, exercise)
  const envDir = toolchain.layout.envDirName ? join(courseDir, toolchain.layout.envDirName) : undefined
  const depsPath = toolchain.layout.depsFile ? join(courseDir, toolchain.layout.depsFile) : undefined
  const task = ensureCourseEnv({
    toolchain,
    courseDir,
    envDir,
    floor: toolchain.parseFloor(runtime.version),
    deps: depsPath && existsSync(depsPath) ? readFileSync(depsPath, 'utf8') : undefined,
    depsPath
  }).then((env) => {
    if (!env.ok) throw new Error(`could not prepare ${toolchain.label}: ${env.message}`)
    return env.tool
  })
  envs.set(key, task)
  return task
}

// `npm test` collects this file too, so it must always register a suite -
// an empty one is a collection error, not a skip.
if (!enabled) {
  describe('exercise gate', () => {
    it.skip('is opt-in: run it with npm run check:exercises', () => undefined)
  })
}

for (const course of COURSES) describe(course.slug, () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), `opencourse-gate-${course.slug}-`))

  if (!course.exercises.length) {
    it('has no exercises to check', () => {
      expect(course.exercises).toHaveLength(0)
    })
    return
  }

  for (const { moduleId, lessonId, lessonTitle, exercise } of course.exercises) {
    const runtime = resolveRuntime(course.manifest, exercise)
    const toolchain = getToolchain(runtime.language)
    const verifiable = Boolean(exercise.tests) || exercise.expected_output !== undefined

    // An exercise without both halves cannot prove anything either way. Saying
    // so out loud beats a silent skip that hides a half-written exercise.
    const label = `${exercise.id} (${toolchain.id}, ${moduleId}/${lessonId})`

    if (!verifiable || !exercise.solution || exercise.starter_code === undefined) {
      it.skip(`${label} — no solution/starter/checks to run`, () => undefined)
      continue
    }

    it(
      label,
      async () => {
        const plan = planScaffold(
          { workspaceRoot, courseId: course.slug, blockId: exercise.id },
          exercise,
          {
            courseTitle: course.manifest.title,
            lessonTitle,
            toolchain,
            runtime,
            coursePackages: runtime.packages
          }
        )
        mkdirSync(plan.exerciseDir, { recursive: true })
        applyScaffold(plan, {
          exists: existsSync,
          write: (path, content) => {
            mkdirSync(join(path, '..'), { recursive: true })
            writeFileSync(path, content)
          }
        })

        const tool = await toolFor(workspaceRoot, course.slug, course.manifest, toolchain, exercise)

        const run = async (source: string): Promise<{ exitCode: number | null; output: string }> => {
          writeFileSync(plan.learnerPath, source)
          const testPlan = toolchain.plan({
            exerciseDir: plan.exerciseDir,
            envDir: plan.envDir,
            tool,
            runtime,
            layout: plan.layout,
            hasTests: plan.hasTests,
            testCommand: exercise.test_command,
            expectedOutput: exercise.expected_output,
            stdin: exercise.stdin,
            match: outputMatch(exercise)
          })
          if (testPlan.kind !== 'ok') throw new Error(`${exercise.id}: ${testPlan.reason}`)
          let output = ''
          const outcome = await runSteps(1, {
            toolchain,
            steps: testPlan.steps,
            cwd: plan.exerciseDir,
            envDir: plan.envDir,
            onData: (chunk) => (output += chunk)
          })
          return { exitCode: outcome.exitCode, output }
        }

        const solution = await run(exercise.solution as string)
        expect(solution.exitCode, `${exercise.id}: the solution does NOT pass its own checks\n${solution.output}`).toBe(0)

        const starter = await run(exercise.starter_code as string)
        expect(
          starter.exitCode,
          `${exercise.id}: the checks also pass against the untouched starter, so they prove nothing\n${starter.output}`
        ).not.toBe(0)
      },
      600_000
    )
  }
})
