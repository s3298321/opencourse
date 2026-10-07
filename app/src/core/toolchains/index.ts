/**
 * The toolchain registry.
 *
 * This is the only module that knows which languages exist. Everything else -
 * the scaffolder, the runner, the workbench, the gates - asks for a descriptor
 * by id and never names a language itself.
 */
import { cToolchain } from './c'
import { llvmIrToolchain } from './llvm'
import { pythonToolchain } from './python'
import { DEFAULT_MATCH } from './output'
import type { CourseManifest, CourseView, ExerciseBlock } from '../types'
import type { OutputMatch, ResolvedRuntime, RuntimeSpec, Toolchain } from './types'

/** What a course gets when it declares no runtime at all. */
export const DEFAULT_LANGUAGE = 'python'

const REGISTRY: Record<string, Toolchain> = {
  [pythonToolchain.id]: pythonToolchain,
  [cToolchain.id]: cToolchain,
  [llvmIrToolchain.id]: llvmIrToolchain
}

export const TOOLCHAIN_IDS = Object.keys(REGISTRY)

export function hasToolchain(id: string): boolean {
  return Object.hasOwn(REGISTRY, id)
}

/**
 * Throws on an unknown id. Manifests are schema-validated against
 * TOOLCHAIN_IDS before they ever reach here, so this is an internal invariant
 * rather than a user-facing error path.
 */
export function getToolchain(id: string | undefined): Toolchain {
  const toolchain = REGISTRY[id ?? DEFAULT_LANGUAGE]
  if (!toolchain) throw new Error(`unknown language: ${id}`)
  return toolchain
}

/**
 * Course runtime under exercise runtime, with the v1.1 spelling folded in.
 * `python_version` and the exercise's bare `packages` predate the runtime
 * object and stay valid, so an archive written against the old format keeps
 * working unchanged.
 */
export function resolveRuntime(course: CourseManifest | CourseView, exercise?: ExerciseBlock): ResolvedRuntime {
  const base: RuntimeSpec = course.runtime ?? {}
  const own: RuntimeSpec = exercise?.runtime ?? {}
  const legacyPackages = exercise?.packages ?? []

  return {
    language: own.language ?? base.language ?? DEFAULT_LANGUAGE,
    version: own.version ?? base.version ?? course.python_version,
    packages: [...new Set([...(base.packages ?? []), ...(own.packages ?? []), ...legacyPackages])],
    flags: own.flags ?? base.flags ?? []
  }
}

/**
 * Every language the course's exercises actually use, in course order. Empty for
 * a course with no exercises at all - which is exactly what a course on
 * economics or music theory looks like, and why the UI must not assume one.
 */
export function courseLanguages(course: CourseManifest | CourseView): string[] {
  const seen: string[] = []
  for (const mod of course.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        if (block.type !== 'exercise') continue
        const id = exerciseLanguage(course, block)
        if (!seen.includes(id)) seen.push(id)
      }
    }
  }
  return seen
}

/**
 * How to label a course's runtime in the UI: nothing when it has no exercises,
 * the language and its floor when it has one, and a plain list when it mixes.
 */
export function runtimeLabel(course: CourseManifest | CourseView): string | undefined {
  const languages = courseLanguages(course)
  if (!languages.length) return undefined
  if (languages.length > 1) return languages.map((id) => getToolchain(id).label).join(', ')
  const toolchain = getToolchain(languages[0])
  const { version } = resolveRuntime(course)
  return version ? toolchain.versionLabel(toolchain.parseFloor(version)) : toolchain.label
}

/** The language an exercise is written in, without resolving the rest. */
export function exerciseLanguage(course: CourseManifest | CourseView, exercise: ExerciseBlock): string {
  return exercise.runtime?.language ?? course.runtime?.language ?? DEFAULT_LANGUAGE
}

export function outputMatch(exercise: ExerciseBlock): OutputMatch {
  return exercise.match ?? DEFAULT_MATCH
}

export { cToolchain, llvmIrToolchain, pythonToolchain }
export * from './types'
export { compareOutput, DEFAULT_MATCH } from './output'
export { SHELL_METACHARACTERS, safeFlags, safeLibs, tokenizeCommand } from './argv'
