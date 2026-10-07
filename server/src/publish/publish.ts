/**
 * Publishing and managing versions.
 *
 * The rules, all enforced here whatever the app checked first:
 *  - a course belongs to the account that first published it;
 *  - a version must be higher than every version ever published for the
 *    course, deleted ones included, so a learner never sees a number reused;
 *  - an element uid belongs to one course forever, never changes kind, and a
 *    flashcard never moves to another lesson (the app's own rule);
 *  - rolling back moves `current_version`; it deletes nothing.
 */
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Account, PublishResult } from '@core/catalog/api'
import { compareVersions, parseVersion } from '@core/catalog/semver'
import { UID } from '@core/catalog/identity'
import { sniffImage } from '@core/sidechat/favicon'
import { resolveInside } from '@core/safepath'
import { nowIso, tx, type Db } from '../db'
import { badRequest, conflict, forbidden, notFound } from '../errors'
import { overviewOf } from '../catalog/overview'
import { refreshListing } from '../catalog/catalog'
import { validateArchive } from './validate'

export const MAX_RELEASE_NOTE = 2000
const MAX_COVER_BYTES = 5 * 1024 * 1024

/** A unique name per publish attempt, so two racing publishes can never share a file. */
const archiveFile = (dataDir: string, courseId: string, version: string): string => join(dataDir, 'archives', courseId, `${version}.${randomUUID()}.zip`)
const coverFile = (dataDir: string, courseId: string, version: string, ext: string): string => join(dataDir, 'covers', courseId, `${version}.${randomUUID()}${ext}`)

interface CourseRecord { id: string; owner_id: string; current_version: string | null; max_version: string; unlisted_at: string | null }

function ownCourse(d: Db, courseId: string, account: Account): CourseRecord {
  if (!UID.test(courseId)) throw notFound()
  const row = d.prepare('SELECT id, owner_id, current_version, max_version, unlisted_at FROM courses WHERE id = ?').get(courseId) as CourseRecord | undefined
  if (!row) throw notFound()
  if (row.owner_id !== account.id) throw forbidden('not_owner', 'Only the account that published this course can change it.')
  return row
}

export async function publishVersion(d: Db, dataDir: string, account: Account, courseId: string, upload: string, releaseNote: string): Promise<PublishResult> {
  if (!UID.test(courseId)) throw badRequest('invalid_course_id', 'A course id is a lowercase UUID v4.')
  if (releaseNote.length > MAX_RELEASE_NOTE) throw badRequest('release_note_too_long', `Keep the release note under ${MAX_RELEASE_NOTE} characters.`)
  const existing = d.prepare('SELECT owner_id, max_version FROM courses WHERE id = ?').get(courseId) as { owner_id: string; max_version: string } | undefined
  if (existing && existing.owner_id !== account.id) throw forbidden('not_owner', 'This course belongs to another account. Make a local copy to publish your own.')

  mkdirSync(join(dataDir, 'tmp'), { recursive: true })
  const staging = mkdtempSync(join(dataDir, 'tmp', 'publish-'))
  try {
    const verdict = await validateArchive(upload, staging)
    if (!verdict.ok) throw badRequest('invalid_archive', 'The course was refused.', { errors: verdict.errors })
    const { manifest, elements } = verdict.archive
    if (manifest.uid !== courseId) throw badRequest('invalid_archive', 'The course was refused.', { errors: [`/uid: the archive is for course ${manifest.uid}, not ${courseId}`] })
    const version = manifest.version!
    const parsed = parseVersion(version)!

    let cover: { bytes: Buffer; type: string; ext: string } | null = null
    if (manifest.cover_image) {
      const file = resolveInside(staging, manifest.cover_image)
      if (file && statSync(file).size <= MAX_COVER_BYTES) {
        const bytes = readFileSync(file), type = sniffImage(bytes)
        if (type && type !== 'image/x-icon') cover = { bytes, type, ext: extname(file).toLowerCase() || '.img' }
      }
    }
    const archiveBytes = readFileSync(upload)
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
    const overview = overviewOf(manifest, cover !== null)
    const at = nowIso()
    const archivePath = archiveFile(dataDir, courseId, version)

    // Files first, rows second: a crash in between leaves an orphan file, never
    // a row pointing at nothing. The version check repeats inside the
    // transaction, because two publishes can race through validation.
    mkdirSync(join(dataDir, 'archives', courseId), { recursive: true })
    const pending = `${archivePath}.tmp`
    copyFileSync(upload, pending)
    renameSync(pending, archivePath)
    let coverPath: string | null = null
    if (cover) {
      coverPath = coverFile(dataDir, courseId, version, cover.ext)
      mkdirSync(join(dataDir, 'covers', courseId), { recursive: true })
      writeFileSync(coverPath, cover.bytes)
    }
    try {
      const created = tx(d, () => {
        const row = d.prepare('SELECT owner_id, max_version FROM courses WHERE id = ?').get(courseId) as { owner_id: string; max_version: string } | undefined
        if (row && row.owner_id !== account.id) throw forbidden('not_owner', 'This course belongs to another account.')
        if (row && compareVersions(version, row.max_version) <= 0) throw conflict('version_not_higher', `Publish a version higher than ${row.max_version}.`, { maxVersion: row.max_version })
        for (const element of elements) {
          const owner = d.prepare('SELECT course_id, kind, parent FROM elements WHERE uid = ?').get(element.uid) as { course_id: string; kind: string; parent: string | null } | undefined
          if (!owner) continue
          if (owner.course_id !== courseId) throw conflict('uid_conflict', 'Some of this course\'s IDs belong to another course on this server. Make a local copy and publish that instead.', { uid: element.uid })
          if (owner.kind !== element.kind) throw badRequest('invalid_archive', 'The course was refused.', { errors: [`${element.kind} ${element.uid}: an element cannot change type; give it a new identity`] })
          if (element.kind === 'flashcard' && owner.parent !== element.parent) throw badRequest('invalid_archive', 'The course was refused.', { errors: [`flashcard ${element.uid}: flashcards are bound to their lesson`] })
        }
        if (row) {
          d.prepare('UPDATE courses SET slug = ?, current_version = ?, max_version = ?, updated_at = ?, unlisted_at = NULL WHERE id = ?').run(manifest.slug, version, version, at, courseId)
        } else {
          d.prepare('INSERT INTO courses(id, owner_id, slug, current_version, max_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(courseId, account.id, manifest.slug, version, version, at, at)
        }
        d.prepare(`INSERT INTO course_versions(course_id, version, major, minor, patch, archive_path, bytes, sha256, cover_path, cover_type, overview, release_note, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(courseId, version, parsed[0], parsed[1], parsed[2], archivePath, archiveBytes.length, sha256, coverPath, cover?.type ?? null, JSON.stringify(overview), releaseNote, at)
        for (const element of elements) {
          d.prepare('INSERT INTO elements(uid, course_id, kind, parent) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET parent = excluded.parent').run(element.uid, courseId, element.kind, element.parent)
        }
        refreshListing(d, courseId)
        return !row
      })
      return { courseId, version, created }
    } catch (error) {
      rmSync(archivePath, { force: true })
      if (coverPath) rmSync(coverPath, { force: true })
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function setCurrentVersion(d: Db, account: Account, courseId: string, version: string): void {
  ownCourse(d, courseId, account)
  const row = d.prepare('SELECT deleted_at FROM course_versions WHERE course_id = ? AND version = ?').get(courseId, version) as { deleted_at: string | null } | undefined
  if (!row || row.deleted_at) throw notFound('That version does not exist.')
  tx(d, () => {
    d.prepare('UPDATE courses SET current_version = ?, updated_at = ? WHERE id = ?').run(version, nowIso(), courseId)
    refreshListing(d, courseId)
  })
}

export function deleteVersion(d: Db, account: Account, courseId: string, version: string): void {
  const course = ownCourse(d, courseId, account)
  const row = d.prepare('SELECT archive_path, cover_path, deleted_at FROM course_versions WHERE course_id = ? AND version = ?').get(courseId, version) as { archive_path: string | null; cover_path: string | null; deleted_at: string | null } | undefined
  if (!row || row.deleted_at) throw notFound('That version does not exist.')
  if (course.current_version === version) throw conflict('current_version', 'This is the current version. Make another version current first, or unpublish the course.')
  d.prepare('UPDATE course_versions SET deleted_at = ?, archive_path = NULL, cover_path = NULL WHERE course_id = ? AND version = ?').run(nowIso(), courseId, version)
  for (const file of [row.archive_path, row.cover_path]) if (file) rmSync(file, { force: true })
}

export function unpublishCourse(d: Db, account: Account, courseId: string): void {
  ownCourse(d, courseId, account)
  tx(d, () => {
    d.prepare('UPDATE courses SET unlisted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), courseId)
    refreshListing(d, courseId)
  })
}

export function relistCourse(d: Db, account: Account, courseId: string): void {
  const course = ownCourse(d, courseId, account)
  if (!course.current_version) throw conflict('no_version', 'Publish a version before listing this course again.')
  tx(d, () => {
    d.prepare('UPDATE courses SET unlisted_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), courseId)
    refreshListing(d, courseId)
  })
}
