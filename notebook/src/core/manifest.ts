/**
 * Turning a validated manifest into what the UI needs.
 * Replaces what apps/courses/views.py did with _siblings() and
 * _prepare_blocks_for_render(), plus the asset-URL rewriting that
 * apps/courses/ingest.py used to bake into the database.
 */
import type { Block, Course, CourseManifest, CourseSummary, CourseView, Lesson, LearnerLesson, LessonRef, CourseItemRef, ProjectModule } from './types'
import { learningManifest, UUID } from './course-document'
import { BRAND } from './brand'

export const ASSET_SCHEME = BRAND.scheme

/**
 * How a course-relative asset path becomes a URL the renderer can use.
 * The default is the opencourse:// scheme; the main process overrides it for the
 * cases where that scheme does not work (see src/main/assets.ts).
 */
export type AssetResolver = (relPath: string) => string

/** `assets/viz/x/index.html` -> `opencourse://<slug>/assets/viz/x/index.html`. */
export function assetUrl(courseId: string, relPath: string): string {
  const clean = relPath.replace(/^\.?\//, '')
  const encoded = clean.split('/').map(encodeURIComponent).join('/')
  return `${ASSET_SCHEME}://${courseId}/${encoded}`
}

/** Every asset path a manifest refers to, relative to the course root. */
export function referencedAssets(manifest: CourseManifest): string[] {
  const out: string[] = []
  if (manifest.cover_image) out.push(manifest.cover_image)
  for (const mod of manifest.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      for (const card of lesson.flashcards ?? []) if (card.image) out.push(card.image.src)
      for (const block of lesson.blocks) {
        if (block.type === 'image' || block.type === 'video' || block.type === 'visualization') {
          out.push(block.src)
        }
        if (block.type === 'video' && block.poster) out.push(block.poster)
      }
    }
  }
  return out
}

/** Rewrites relative asset paths to app URLs. Returns a copy; the input is untouched. */
export function resolveBlockAssets(block: Block, resolve: AssetResolver): Block {
  switch (block.type) {
    case 'image':
      return { ...block, src: resolve(block.src) }
    case 'video':
      return {
        ...block,
        src: resolve(block.src),
        ...(block.poster ? { poster: resolve(block.poster) } : {})
      }
    case 'visualization':
      return { ...block, src: resolve(block.src) }
    default:
      return block
  }
}

export function flattenLessons(manifest: CourseManifest): LessonRef[] {
  const out: LessonRef[] = []
  for (const mod of manifest.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      out.push({
        moduleId: mod.slug,
        moduleTitle: mod.title,
        lessonId: lesson.slug,
        title: lesson.title,
        index: out.length
      })
    }
  }
  return out
}

export function lessonKey(moduleId: string, lessonId: string): string {
  return UUID.test(lessonId) ? lessonId : `${moduleId}/${lessonId}`
}

export function buildCourse(
  manifest: CourseManifest,
  root: string,
  resolve: AssetResolver = (rel) => assetUrl(manifest.slug, rel),
  courseId = manifest.slug,
  revision = 0
): Course {
  manifest = learningManifest(manifest)
  const flatLessons = flattenLessons(manifest)
  const quizIds: string[] = []
  const exerciseIds: string[] = []
  let totalMinutes = 0

  const modules = manifest.modules.map((mod) => mod.type === 'project' ? (totalMinutes += mod.project.estimated_minutes ?? 0, mod) : ({
    ...mod,
    lessons: mod.lessons.map((lesson) => {
      totalMinutes += lesson.estimated_minutes ?? 0
      for (const block of lesson.blocks) {
        if (block.type === 'quiz') quizIds.push(block.id)
        if (block.type === 'exercise') exerciseIds.push(block.id)
      }
      return {
        ...lesson,
        flashcards: lesson.flashcards?.map(card => ({ ...card, ...(card.image ? { image: { ...card.image, src: resolve(card.image.src) } } : {}) })),
        blocks: lesson.blocks.map((b) => resolveBlockAssets(b, resolve))
      } satisfies Lesson
    })
  }))

  return {
    ...manifest,
    courseId,
    revision,
    modules,
    root,
    coverUrl: manifest.cover_image ? resolve(manifest.cover_image) : undefined,
    flatLessons,
    flatItems: flattenItems(manifest),
    totalMinutes,
    quizIds,
    exerciseIds
  }
}

export function summarize(course: CourseView): CourseSummary {
  return {
    courseId: course.courseId,
    slug: course.slug,
    title: course.title,
    description: course.description,
    author: course.author,
    difficulty: course.difficulty,
    estimated_hours: course.estimated_hours,
    subject: course.subject,
    tags: course.tags,
    coverUrl: course.coverUrl,
    lessonCount: course.flatLessons.length,
    projectCount: course.flatItems.filter((i) => i.kind === 'project').length
  }
}

export function findLesson(
  course: CourseView,
  moduleId: string,
  lessonId: string
): { module: CourseView['modules'][number]; lesson: LearnerLesson; ref: LessonRef } | undefined {
  const mod = course.modules.find((m) => m.type !== 'project' && (UUID.test(lessonId) ? m.lessons.some((l) => l.slug === lessonId) : m.slug === moduleId))
  if (!mod || mod.type === 'project') return undefined
  const lesson = mod.lessons.find((l) => l.slug === lessonId)
  const ref = course.flatLessons.find((r) => r.moduleId === mod.slug && r.lessonId === lessonId)
  if (!mod || !lesson || !ref) return undefined
  return { module: mod, lesson, ref }
}

export function siblings(course: CourseView, index: number): { prev?: LessonRef; next?: LessonRef } {
  return {
    prev: index > 0 ? course.flatLessons[index - 1] : undefined,
    next: index < course.flatLessons.length - 1 ? course.flatLessons[index + 1] : undefined
  }
}

/** Ordered learning items; lesson numbering remains lesson-only. */
export function flattenItems(manifest: CourseManifest): CourseItemRef[] {
  const items: CourseItemRef[] = []
  for (const mod of manifest.modules) {
    if (mod.type === 'project') items.push({ kind: 'project', moduleId: mod.slug, title: mod.title, index: items.length })
    else for (const lesson of mod.lessons) items.push({ kind: 'lesson', moduleId: mod.slug, moduleTitle: mod.title, lessonId: lesson.slug, title: lesson.title, index: items.length })
  }
  return items
}
export function findProject(course: CourseView, moduleId: string): ProjectModule | undefined {
  return course.modules.find((m): m is ProjectModule => m.type === 'project' && m.slug === moduleId)
}
export function itemSiblings(course: CourseView, moduleId: string, lessonId?: string): { prev?: CourseItemRef; next?: CourseItemRef } {
  const index = course.flatItems.findIndex((i) => i.moduleId === moduleId && (i.kind === 'project' ? lessonId === undefined : i.lessonId === lessonId))
  return index < 0 ? {} : { prev: course.flatItems[index - 1], next: course.flatItems[index + 1] }
}
