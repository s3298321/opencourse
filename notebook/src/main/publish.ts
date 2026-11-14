/**
 * Publishing a course to a server, and managing what was published.
 *
 * Publishing sends the last saved version with its existing IDs as uids
 * (core/catalog/identity.ts), so the publisher's own library is not renamed
 * and the course they keep editing stays the same course on the server. From
 * then on the document carries an origin with role `publisher`: it is a
 * server course, and its owner edits it in place.
 *
 * The server enforces every rule here again - ownership, versions only going
 * up - so these checks exist to say no early and in words, not to be trusted.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedCourse, PublishResult } from '../core/catalog/api'
import type { PublishPreview } from '../core/types'
import { publishedManifest } from '../core/catalog/identity'
import { parseManagedCourse, parsePublishResult } from '../core/catalog/parse'
import { compareVersions, DEFAULT_COURSE_VERSION, isVersion } from '../core/catalog/semver'
import { requireCourseUid } from './catalog'
import { beginCourseMutation, courseBusy } from './course-busy'
import { isEditSessionDirty, packCourse } from './course-authoring'
import { atomicJSON, courseDirectory, readDocument } from './course-store'
import { reloadCourses } from './courses'
import { callServer, ServerError, uploadArchive } from './serverclient'
import { serverAccess } from './servers'
import { log } from './log'

export async function previewPublish(rawCourseId: string, serverId: string): Promise<PublishPreview> {
  const courseId = requireCourseUid(rawCourseId)
  const document = readDocument(courseId)
  const access = serverAccess(serverId)
  const problems: string[] = []
  if (!document.manifest) throw new ServerError(400, 'unsaved', 'Save the course before publishing it.')
  if (!access.token) problems.push(`Sign in to ${access.name} in Settings first.`)
  if (isEditSessionDirty(courseId)) problems.push('Save or discard the unsaved edits in the editor first.')
  const origin = document.origin
  if (origin?.role === 'learner') problems.push(`This course was published by ${origin.publisher}. Edit it to make a local copy, and publish the copy.`)
  else if (origin && origin.server !== access.url) problems.push(`This course is published on ${origin.serverName}. Edit it there, or make a copy to publish elsewhere.`)
  const version = document.manifest.version ?? DEFAULT_COURSE_VERSION
  let maxVersion: string | null = null, currentVersion: string | null = null
  if (origin?.role === 'publisher' && origin.server === access.url && access.token) {
    try {
      const managed = await callServer(access.url, `/courses/${courseId}/versions`, parseManagedCourse, { token: access.token, route: '/courses/:id/versions' })
      maxVersion = managed.maxVersion; currentVersion = managed.currentVersion
    } catch (error) {
      if (!(error instanceof ServerError) || error.status !== 404) throw error
    }
  }
  if (!isVersion(version)) problems.push('Give the course a version like 1.0.0 (Course details → Version) and save it.')
  else if (maxVersion && compareVersions(version, maxVersion) <= 0) problems.push(`Version ${version} is not higher than v${maxVersion}, the highest published. Raise it in the editor (Course details → Version) and save.`)
  return { serverName: access.name, title: document.manifest.title, version, maxVersion, currentVersion, problems }
}

export async function publishCourse(rawCourseId: string, serverId: string, releaseNote: string): Promise<PublishResult> {
  const courseId = requireCourseUid(rawCourseId)
  const preview = await previewPublish(courseId, serverId)
  if (preview.problems.length) throw new ServerError(409, 'cannot_publish', preview.problems[0]!)
  if (courseBusy(courseId)) throw new ServerError(409, 'busy', 'This course is being saved. Try again in a moment.')
  const access = serverAccess(serverId)
  const release = beginCourseMutation(courseId)
  const work = mkdtempSync(join(tmpdir(), 'opencourse-publish-'))
  try {
    const zip = join(work, 'course.zip')
    await packCourse(courseId, zip, (manifest) => publishedManifest(manifest, courseId))
    const note = String(releaseNote ?? '').trim().slice(0, 2000)
    const result = await uploadArchive(access.url, `/courses/${courseId}/versions`, zip, parsePublishResult, {
      token: access.token, route: '/courses/:id/versions', headers: note ? { 'x-opencourse-release-note': encodeURIComponent(note) } : {}
    })
    // The course is now the server's too. Only the origin changes; the content
    // is exactly what was saved, so there is no revision to bump.
    const document = readDocument(courseId)
    atomicJSON(join(courseDirectory(courseId), 'document.json'), {
      ...document,
      origin: { kind: 'server', server: access.url, serverName: access.name, version: result.version, role: 'publisher', publisher: access.account!.username, installedAt: document.origin?.installedAt ?? new Date().toISOString(), revision: document.revision }
    })
    log.child('servers').info('Course published', { data: { courseId, version: result.version, created: result.created } })
    return result
  } finally {
    rmSync(work, { recursive: true, force: true })
    release()
    reloadCourses()
  }
}

/* --- managing -------------------------------------------------------------- */

function owned(serverId: string): { url: string; token: string } {
  const access = serverAccess(serverId)
  if (!access.token) throw new ServerError(401, 'signed_out', `Sign in to ${access.name} in Settings first.`)
  return { url: access.url, token: access.token }
}

export async function publishedCourse(serverId: string, courseId: string): Promise<ManagedCourse> {
  const { url, token } = owned(serverId)
  return callServer(url, `/courses/${requireCourseUid(courseId)}/versions`, parseManagedCourse, { token, route: '/courses/:id/versions' })
}

export async function setCurrentPublished(serverId: string, courseId: string, version: string): Promise<ManagedCourse> {
  const { url, token } = owned(serverId)
  if (!isVersion(version)) throw new ServerError(400, 'invalid_version', 'That is not a version.')
  return callServer(url, `/courses/${requireCourseUid(courseId)}/current`, parseManagedCourse, { method: 'PUT', json: { version }, token, route: '/courses/:id/current' })
}

export async function deletePublishedVersion(serverId: string, courseId: string, version: string): Promise<ManagedCourse> {
  const { url, token } = owned(serverId)
  if (!isVersion(version)) throw new ServerError(400, 'invalid_version', 'That is not a version.')
  return callServer(url, `/courses/${requireCourseUid(courseId)}/versions/${version}`, parseManagedCourse, { method: 'DELETE', token, route: '/courses/:id/versions/:version' })
}

export async function unpublishCourse(serverId: string, courseId: string): Promise<ManagedCourse> {
  const { url, token } = owned(serverId)
  return callServer(url, `/courses/${requireCourseUid(courseId)}`, parseManagedCourse, { method: 'DELETE', token, route: '/courses/:id' })
}

export async function relistCourse(serverId: string, courseId: string): Promise<ManagedCourse> {
  const { url, token } = owned(serverId)
  return callServer(url, `/courses/${requireCourseUid(courseId)}/relist`, parseManagedCourse, { method: 'POST', token, route: '/courses/:id/relist' })
}
