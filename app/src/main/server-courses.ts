/**
 * Courses that come from a server: adding one, checking for and applying
 * updates.
 *
 * A server's archive is treated exactly like a ZIP someone handed the user -
 * the same unzip policy, the same schema, the same asset checks - and then
 * more: every element must carry the server's uid, the course must be the one
 * that was asked for, and it must be a version. What it gets in return is
 * identity. The library course *is* the server course (same course ID, same
 * element IDs), which is what lets an update keep progress on everything that
 * survived, and what makes adding the same course twice impossible.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '../core/import'
import type { CourseStatus } from '../core/catalog/api'
import { adoptPublishedManifest } from '../core/catalog/identity'
import { parseOverview, parseStatuses } from '../core/catalog/parse'
import { isVersion } from '../core/catalog/semver'
import { updateState, type CourseOrigin, type UpdateState } from '../core/catalog/origin'
import { courseNodes, deletedNodes, validateIdentities, type CourseDocument } from '../core/course-document'
import type { CourseManifest, CourseUpdatePreview } from '../core/types'
import { beginCourseMutation, courseBusy } from './course-busy'
import { changeCleanup, commitCourseChange, deletionImpact, isEditSessionDirty, stopCourseActivity } from './course-authoring'
import { importedAttachments } from './assets'
import { removeEditSession } from './edit-sessions'
import { requireCourseUid } from './catalog'
import { courseDirectory, readDocument } from './course-store'
import { listCourses, loadCourseAt, reloadCourses } from './courses'
import { adoptPackage } from './import'
import { callServer, downloadArchive, ServerError } from './serverclient'
import { serverAccess, serverAccessForUrl, type ServerAccess } from './servers'
import { extractArchive } from './unzip'
import { requireUser } from './users'
import { log } from './log'

const invalid = (detail: string): ServerError => new ServerError(422, 'invalid_course', `The server sent a course this app cannot use: ${detail}`)

/** Unpacks and checks a downloaded archive; returns its manifest with nodeIds set to the server's uids. */
export async function unpackServerCourse(zip: string, staging: string, expectedId: string): Promise<CourseManifest> {
  mkdirSync(staging, { recursive: true })
  const { error } = await extractArchive(zip, staging)
  if (error) throw invalid(error)
  const loaded = loadCourseAt(staging)
  if ('error' in loaded) throw invalid(loaded.error)
  const raw = JSON.parse(readFileSync(join(staging, 'course.json'), 'utf8')) as CourseManifest
  if (!isVersion(raw.version)) throw invalid('it has no version')
  const adopted = adoptPublishedManifest(raw)
  if (!adopted.ok) throw invalid(adopted.errors[0] ?? 'its identities are missing')
  if (adopted.courseId !== expectedId) throw invalid('it is a different course from the one requested')
  const identityErrors = validateIdentities(adopted.manifest)
  if (identityErrors.length) throw invalid(identityErrors[0]!)
  return adopted.manifest
}

function signedIn(access: ServerAccess): string {
  if (!access.token) throw new ServerError(401, 'signed_out', `Sign in to ${access.name} in Settings first.`)
  return access.token
}

/** Downloads the current version into a scratch folder and hands it to `use`. */
async function withDownload<T>(access: ServerAccess, courseId: string, intent: 'add' | 'update', use: (staging: string, manifest: CourseManifest) => Promise<T> | T): Promise<T> {
  const owner = requireUser()
  const work = mkdtempSync(join(tmpdir(), 'opencourse-server-course-'))
  try {
    const zip = join(work, 'course.zip'), staging = join(work, 'course')
    await downloadArchive(access.url, `/courses/${courseId}/download`, zip, LIMITS.archiveBytes, { method: 'POST', json: { intent }, token: signedIn(access), route: '/courses/:id/download' })
    if (requireUser() !== owner) throw new ServerError(409, 'user_changed', 'The active user changed during the download.')
    const manifest = await unpackServerCourse(zip, staging, courseId)
    return await use(staging, manifest)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function originFor(access: ServerAccess, manifest: CourseManifest, publisher: string, ownedByYou: boolean): CourseOrigin {
  return { kind: 'server', server: access.url, serverName: access.name, version: manifest.version!, role: ownedByYou ? 'publisher' : 'learner', publisher, installedAt: new Date().toISOString(), revision: 1 }
}

/** Adds the current version of a catalog course to the library. */
export async function addFromServer(serverId: string, rawCourseId: string): Promise<{ courseId: string; title: string; version: string }> {
  const courseId = requireCourseUid(rawCourseId)
  const access = serverAccess(serverId)
  signedIn(access)
  if (existsSync(join(courseDirectory(courseId), 'document.json'))) throw new ServerError(409, 'exists', 'This course is already in your library.')
  const overview = await callServer(access.url, `/courses/${courseId}`, parseOverview, { token: access.token, route: '/courses/:id' })
  return withDownload(access, courseId, 'add', (staging, manifest) => {
    try {
      adoptPackage(staging, courseId, manifest, originFor(access, manifest, overview.publisher, overview.ownedByYou))
    } catch (error) {
      if ((error as Error).message.includes('another course')) throw new ServerError(409, 'id_conflict', 'This course shares identities with another course in your library, so it cannot be added beside it.')
      if ((error as Error).message.includes('already in your library')) throw new ServerError(409, 'exists', 'This course is already in your library.')
      throw error
    }
    log.child('servers').info('Course added from a server', { data: { courseId, version: manifest.version, host: new URL(access.url).host } })
    return { courseId, title: manifest.title, version: manifest.version! }
  })
}

/** Update state for every server course in the library, asked of each server once. */
export async function courseUpdates(): Promise<Record<string, UpdateState>> {
  const byServer = new Map<string, { courseId: string; version: string }[]>()
  for (const course of listCourses()) {
    if (!course.origin || course.error) continue
    let installed: string
    try { installed = readDocument(course.courseId).origin!.version } catch { continue }
    const list = byServer.get(course.origin.server) ?? []
    list.push({ courseId: course.courseId, version: installed })
    byServer.set(course.origin.server, list)
  }
  const out: Record<string, UpdateState> = {}
  await Promise.all([...byServer].map(async ([server, courses]) => {
    const access = serverAccessForUrl(server)
    if (!access) { for (const c of courses) out[c.courseId] = { kind: 'disconnected', reason: 'not-connected' }; return }
    let statuses: CourseStatus[] | null = null
    try {
      statuses = await callServer(access.url, '/courses/status', parseStatuses, { method: 'POST', json: { ids: courses.map((c) => c.courseId) }, token: access.token || null, route: '/courses/status' })
    } catch { /* reported per course below */ }
    for (const c of courses) {
      out[c.courseId] = statuses ? updateState(c.version, statuses.find((s) => s.id === c.courseId)) : { kind: 'disconnected', reason: 'unreachable' }
    }
  }))
  return out
}

/* --- updating -------------------------------------------------------------- */

/**
 * A downloaded update waits here between its preview and the learner's yes,
 * so the confirmation describes exactly what will be installed and the server
 * counts one update, not two.
 */
interface StagedUpdate { userId: string; work: string; staging: string; manifest: CourseManifest; expires: number }
const staged = new Map<string, StagedUpdate>()
const STAGE_TTL_MS = 15 * 60_000

function dropStaged(courseId: string): void {
  const entry = staged.get(courseId)
  if (entry) rmSync(entry.work, { recursive: true, force: true })
  staged.delete(courseId)
}

export function forgetStagedUpdates(): void {
  for (const courseId of [...staged.keys()]) dropStaged(courseId)
}

type ServerDocument = CourseDocument & { origin: CourseOrigin; manifest: CourseManifest }

function serverCourse(courseId: string): { document: ServerDocument; access: ServerAccess } {
  const document = readDocument(requireCourseUid(courseId))
  if (!document.origin || !document.manifest) throw new ServerError(400, 'not_server_course', 'This course is not from a server.')
  const access = serverAccessForUrl(document.origin.server)
  if (!access) throw new ServerError(409, 'not_connected', `${document.origin.serverName} is not connected. Add it again in Settings to update this course.`)
  return { document: document as ServerDocument, access }
}

/** Downloads the current version and says what installing it would do. */
export async function previewCourseUpdate(courseId: string): Promise<CourseUpdatePreview> {
  const { document, access } = serverCourse(courseId)
  dropStaged(courseId)
  const owner = requireUser()
  const work = mkdtempSync(join(tmpdir(), 'opencourse-update-'))
  try {
    const zip = join(work, 'course.zip'), staging = join(work, 'course')
    await downloadArchive(access.url, `/courses/${courseId}/download`, zip, LIMITS.archiveBytes, { method: 'POST', json: { intent: 'update' }, token: signedIn(access), route: '/courses/:id/download' })
    const manifest = await unpackServerCourse(zip, staging, courseId)
    const typeChanges = validateIdentities(manifest, document.manifest)
    if (typeChanges.length) throw invalid(typeChanges[0]!)
    staged.set(courseId, { userId: owner, work, staging, manifest, expires: Date.now() + STAGE_TTL_MS })
    const before = new Set(courseNodes(document.manifest).map((n) => n.id))
    const added = courseNodes(manifest).filter((n) => !before.has(n.id))
    const removed = deletedNodes(document.manifest, manifest)
    return {
      from: document.origin.version, to: manifest.version!,
      removed: removed.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
      ...deletionImpact(courseId, removed),
      newLessons: added.filter((n) => n.kind === 'lesson').length,
      newProjects: added.filter((n) => n.kind === 'project').length,
      overwritesLocalEdits: document.origin.role === 'publisher' && document.revision > document.origin.revision
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw error
  }
}

/**
 * Installs the previewed version. Progress follows element IDs: everything
 * that still exists keeps its completion, attempts, files and chats, edited or
 * not; what the new version removed goes, as the preview said; new lessons
 * start incomplete. The package is swapped inside the same journaled commit as
 * the document, so an interrupted update finishes or never happened.
 */
export async function applyCourseUpdate(courseId: string): Promise<{ version: string }> {
  const owner = requireUser()
  const pending = staged.get(courseId)
  if (!pending || pending.userId !== owner || pending.expires < Date.now()) { dropStaged(courseId); throw new ServerError(409, 'stale', 'Check for the update again before installing it.') }
  if (isEditSessionDirty(courseId)) throw new ServerError(409, 'editing', 'This course has unsaved edits open in the editor. Save or discard them first.')
  if (courseBusy(courseId)) throw new ServerError(409, 'busy', 'This course is being saved. Try again in a moment.')
  const release = beginCourseMutation(courseId)
  try {
    const { document } = serverCourse(courseId)
    await stopCourseActivity(owner, courseId)
    if (requireUser() !== owner) throw new ServerError(409, 'user_changed', 'The active user changed during the update.')
    const manifest = pending.manifest
    const root = courseDirectory(courseId)
    const next = join(root, 'package.next')
    rmSync(next, { recursive: true, force: true })
    cpSync(pending.staging, next, { recursive: true })
    rmSync(join(next, 'course.json'), { force: true })
    const removed = deletedNodes(document.manifest, manifest)
    const updated: CourseDocument = {
      version: 1, courseId, revision: document.revision + 1, manifest, attachments: importedAttachments(next, manifest),
      origin: { ...document.origin, version: manifest.version!, installedAt: new Date().toISOString(), revision: document.revision + 1 }
    }
    try {
      commitCourseChange(courseId, updated, document.manifest, removed, changeCleanup(owner, courseId, document.manifest, manifest, removed), { packageSwap: true })
    } catch (error) {
      rmSync(next, { recursive: true, force: true })
      throw error
    }
    // A clean edit session described the old version; the editor reopens on this one.
    removeEditSession(owner, courseId)
    log.child('servers').info('Course updated from a server', { data: { courseId, from: document.origin.version, to: manifest.version } })
    return { version: manifest.version! }
  } finally {
    release()
    dropStaged(courseId)
    reloadCourses()
  }
}

export function cancelCourseUpdate(courseId: string): void {
  dropStaged(courseId)
}
