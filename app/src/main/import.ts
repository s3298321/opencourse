import { importedAttachments } from './assets'
import { beginCourseMutation } from './course-busy'
/**
 * Bringing a course into a user's library.
 *
 * Nothing lands in `courses/` until the whole archive has been unpacked into a
 * staging directory and validated there, so a rejected import leaves the
 * library exactly as it was.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { identifyManifest } from '../core/course-document'
import { DEFAULT_COURSE_VERSION } from '../core/catalog/semver'
import type { CourseDocument } from '../core/course-document'
import { atomicJSON, courseDirectory, ensureCourseStorage, commitCourseOperation } from './course-store'
import { registerDocument } from './course-registry'
import { LIMITS } from '../core/import'
import { resolveInside } from '../core/safepath'
import { assertSafeSegment } from '../core/scaffold'
import type { CourseManifest, ImportResult } from '../core/types'
import type { CourseOrigin } from '../core/catalog/origin'
import { loadCourseAt, reloadCourses } from './courses'
import { courseProjectsRoot, courseProjectStateDir, dataRoot, userCoursesDir, userProgressDir, userWorkspaceRoot } from './paths'
import { assertOwnedProjectAncestors } from './projectfiles'
import { cancelCourseChats } from './chat'
import { cancelCourseProjectChats } from './projectchat'
import { cancelCourseAuthoring } from './authoring-state'
import { tx } from './db'
import { stopCourseWork } from './toolchain'
import { disposePtysInDirectory } from './pty'
import { extractArchive } from './unzip'
import { requireUser } from './users'

/**
 * Moves an unpacked, validated course into the library under `courseId`. A ZIP
 * import passes a fresh UUID and fresh element IDs; a server download passes
 * the server's own (core/catalog/identity.ts) and where it came from. Either
 * way an ID already used by another course in this library is refused by
 * registerDocument, and nothing is left behind.
 */
export function adoptPackage(dir: string, courseId: string, manifest: CourseManifest, origin?: CourseOrigin): void {
  const root = courseDirectory(courseId)
  if (existsSync(join(root, 'document.json'))) throw new Error('That course is already in your library.')
  const destination = join(root, 'package')
  const document: CourseDocument = { version: 1, courseId, revision: 1, manifest, attachments: importedAttachments(dir, manifest), ...(origin ? { origin } : {}) }
  mkdirSync(root, { recursive: true })
  try {
    try { renameSync(dir, destination) } catch {
      cpSync(dir, destination, { recursive: true })
      rmSync(dir, { recursive: true, force: true })
    }
    // course.json is generated on export; the app-local document is authoritative.
    rmSync(join(destination, 'course.json'), { force: true })
    atomicJSON(join(root, 'document.json'), document)
    tx((d) => registerDocument(d, document))
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
  reloadCourses()
}

/**
 * The tail of an import: validate the unpacked directory, then move it into the
 * user's library under a fresh app-local UUID.
 */
function adoptCourseDir(dir: string): ImportResult {
  const loaded = loadCourseAt(dir)
  if ('error' in loaded) return { status: 'invalid', message: loaded.error }
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
  const courseId = randomUUID()
  // An archive from before 1.5 has no version of its own; it starts where a new course does.
  adoptPackage(dir, courseId, { ...identifyManifest(manifest, randomUUID), version: manifest.version ?? DEFAULT_COURSE_VERSION })
  return { status: 'ok', courseId, title: loaded.title }
}

export async function importCourseZip(zipPath: string): Promise<ImportResult> {
  const owner = requireUser()
  ensureCourseStorage()
  let size: number
  try {
    size = statSync(zipPath).size
  } catch {
    return { status: 'rejected', message: 'that file could not be read' }
  }
  if (size > LIMITS.archiveBytes) {
    return { status: 'rejected', message: `the archive is larger than ${LIMITS.archiveBytes / 1024 / 1024} MB` }
  }

  const staging = mkdtempSync(join(tmpdir(), 'opencourse-import-'))
  try {
    const { error } = await extractArchive(zipPath, staging)
    if (error) return { status: 'rejected', message: error }
    if (requireUser() !== owner) return { status: 'rejected', message: 'The active user changed during import.' }
    return adoptCourseDir(staging)
  } catch (err) {
    return { status: 'rejected', message: `could not read the archive: ${(err as Error).message}` }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Deletes a course and all of its learner data. Re-importing starts fresh.
 */
export async function removeCourse(courseId: string): Promise<void> {
  if (typeof courseId !== 'string') throw new Error('invalid course ID')
  assertSafeSegment(courseId, 'course ID')
  const release = beginCourseMutation(courseId)
  try {
  const userId = requireUser()
  const courses = userCoursesDir(userId)
  // The course ID comes from the renderer, so prove it names a course in this
  // user's library before deleting anything.
  if (!resolveInside(courses, join(courseId, 'document.json'))) throw new Error(`unknown course: ${courseId}`)

  const related = [
    join(userProgressDir(userId), `${courseId}.json`),
    join(userWorkspaceRoot(userId), courseId),
    join(courseProjectsRoot(userId), courseId),
    courseProjectStateDir(userId, courseId)
  ]
  // Validate every parent before deleting anything. rmSync removes a leaf
  // symlink itself, but a symlinked parent could redirect deletion elsewhere.
  for (const target of [...related, join(courses, courseId)]) {
    assertOwnedProjectAncestors(dataRoot(), dirname(target))
  }

  // Project cancellation saves any partial reply synchronously; do it before
  // deleting the rows. Late side-chat replies check that their chat still exists.
  cancelCourseChats(courseId)
  cancelCourseProjectChats(courseId)
  cancelCourseAuthoring(courseId)
  disposePtysInDirectory(join(userWorkspaceRoot(userId), courseId))
  await stopCourseWork(join(userWorkspaceRoot(userId), courseId))
  if (requireUser() !== userId) throw new Error('Course deletion was interrupted because the active user changed.')
  for (const target of [...related, join(courses, courseId)]) {
    assertOwnedProjectAncestors(dataRoot(), dirname(target))
  }
  commitCourseOperation(null, null, courseId, [...related, join(courses, courseId)], (d) => {
    d.prepare('DELETE FROM library_courses WHERE id=?').run(courseId)
    d.prepare('DELETE FROM chats WHERE course_slug = ?').run(courseId)
    d.prepare('DELETE FROM course_project_chats WHERE course_slug = ?').run(courseId)
  })
  // Remove whole course namespaces, including projects no longer in the
  // manifest. Keep the library entry until all learner files are removed so
  // a filesystem error leaves deletion available to retry.
  reloadCourses()
  } finally { reloadCourses(); release() }
}
