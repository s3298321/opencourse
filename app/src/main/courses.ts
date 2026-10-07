/**
 * Finding and loading course packages.
 *
 * A UUID directory contains an app-local document and a portable package. The
 * app validates saved content on load; imported and manually authored courses
 * belong to the current user.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildCourse, referencedAssets, summarize } from '../core/manifest'
import { summarizeProgress } from '../core/progress'
import { makeAssetResolver } from './assets'
import { validateManifest } from '../core/schema'
import type { Course, CourseManifest, CourseSummary } from '../core/types'
import { userCoursesDir } from './paths'
import { readProgress } from './progress'
import { ensureCourseStorage, readDocument, validateLocalDocument } from './course-store'
import { validateIdentities } from '../core/course-document'
import { db, tx } from './db'
import { registerDocument } from './course-registry'
import { currentUserId } from './users'
import { DEFAULT_COURSE_VERSION } from '../core/catalog/semver'

interface LoadFailure {
  courseId: string
  slug: string
  draft?: boolean
  title?: string
  root: string
  error: string
}

let cache: { userId: string; courses: Map<string, Course>; failures: LoadFailure[] } | null = null

function listCourseDirs(parent: string): string[] {
  if (!existsSync(parent)) return []
  return readdirSync(parent)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(parent, name))
    .filter((dir) => {
      // A broken symlink here must not take down the whole library.
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'document.json'))
      } catch {
        return false
      }
    })
}

/** Validates a course directory. Returns the course, or a human-readable error. */
export function loadCourseAt(root: string): Course | { error: string } {
  let manifest: CourseManifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'course.json'), 'utf8')) as CourseManifest
  } catch (err) {
    return { error: `course.json is not valid JSON: ${(err as Error).message}` }
  }

  const errors = validateManifest(manifest)
  if (errors.length) return { error: errors.slice(0, 5).join('; ') }

  const missing = referencedAssets(manifest).filter((rel) => !existsSync(join(root, rel)))
  if (missing.length) {
    return { error: `missing asset(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}` }
  }

  return buildCourse(manifest, root, makeAssetResolver(root, manifest.slug))
}

function load(): NonNullable<typeof cache> {
  const userId = currentUserId()
  if (!userId) return { userId: '', courses: new Map(), failures: [] }
  if (cache && cache.userId === userId) return cache

  ensureCourseStorage()
  const courses = new Map<string, Course>()
  const failures: LoadFailure[] = []

  for (const dir of listCourseDirs(userCoursesDir(userId))) {
    const courseId = basename(dir)
    let displayTitle = 'Unavailable course'
    try {
      const document = readDocument(courseId)
      displayTitle = document.manifest?.title ?? document.legacySlug ?? 'Untitled course'
      if (document.error) throw new Error(document.error)
      if (!document.manifest) {
        let title = 'Untitled course'
        try { title = JSON.parse(readFileSync(join(dir, 'draft.json'), 'utf8')).manifest.title || title } catch { /* recoverable */ }
        failures.push({ courseId, slug: document.legacySlug ?? 'untitled-course', title, draft: true, root: dir, error: '' })
        continue
      }
      const errors = [...validateLocalDocument(document), ...validateIdentities(document.manifest)]
      if (errors.length) throw new Error(errors.slice(0, 5).join('; '))
      const root = join(dir, 'package')
      const missing = referencedAssets(document.manifest).filter((rel) => !existsSync(join(root, rel)))
      if (missing.length) throw new Error(`missing assets: ${missing.slice(0, 3).join(', ')}`)
      if (!db().prepare('SELECT id FROM library_courses WHERE id=?').get(courseId)) tx((d) => registerDocument(d, document))
      const course = buildCourse(document.manifest, root, makeAssetResolver(root, courseId), courseId, document.revision)
      courses.set(courseId, document.origin ? { ...course, origin: document.origin } : course)
    } catch (err) {
      failures.push({ courseId, slug: courseId, title: displayTitle, root: dir, error: (err as Error).message })
    }
  }

  cache = { userId, courses, failures }
  return cache
}

/** Call after anything that changes what is on disk, or who is looking at it. */
export function reloadCourses(): void {
  cache = null
}

export function listCourses(): CourseSummary[] {
  const { courses, failures } = load()
  const summaries = [...courses.values()].map((course) => {
    const document = readDocument(course.courseId)
    const origin = document.origin
    return {
      ...summarize(course),
      version: course.version ?? DEFAULT_COURSE_VERSION,
      ...(origin ? { origin: { server: origin.server, serverName: origin.serverName, role: origin.role, publisher: origin.publisher } } : {}),
      ...(document.recoveryNotes?.length ? { recoveryNotice: 'Some older progress or messages could not be linked to course elements. Their original data is retained; details are in the .course-migration recovery folder.' } : {}),
      progressPercent: summarizeProgress(course, readProgress(course.courseId)).percent
    }
  })
  summaries.sort((a, b) => a.title.localeCompare(b.title))
  return [
    ...summaries,
    ...failures.map((f) => ({ courseId: f.courseId, slug: f.slug, title: f.title ?? f.slug, draft: f.draft, lessonCount: 0, projectCount: 0, ...(f.error ? { error: f.error } : {}) }))
  ]
}

export function getCourse(courseId: string): Course | undefined {
  return load().courses.get(courseId)
}
