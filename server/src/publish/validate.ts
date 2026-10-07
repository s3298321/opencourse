/**
 * What a published archive has to be, checked with the app's own code.
 *
 * The archive is unpacked by the app's extractArchive under the app's course
 * policy (zip slip, symlinks, file types, sizes), its course.json validated by
 * the app's schema, and its identities by core/catalog/identity.ts - so the
 * server cannot accept a course the app would refuse, or the reverse.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractArchive } from '@app/unzip'
import { validateManifest } from '@core/schema'
import { referencedAssets } from '@core/manifest'
import { resolveInside } from '@core/safepath'
import { CURRENT_SCHEMA_VERSION } from '@core/course-document'
import { adoptPublishedManifest, publishedIdentityErrors } from '@core/catalog/identity'
import { courseNodes } from '@core/course-document'
import type { CourseManifest } from '@core/types'

export interface ValidArchive {
  manifest: CourseManifest
  /** Every element's uid, kind and parent, in manifest order. */
  elements: { uid: string; kind: string; parent: string | null }[]
}

export type ArchiveVerdict = { ok: true; archive: ValidArchive } | { ok: false; errors: string[] }

export async function validateArchive(zipPath: string, staging: string): Promise<ArchiveVerdict> {
  const { error } = await extractArchive(zipPath, staging)
  if (error) return { ok: false, errors: [error] }
  let manifest: CourseManifest
  try {
    manifest = JSON.parse(readFileSync(join(staging, 'course.json'), 'utf8')) as CourseManifest
  } catch (err) {
    return { ok: false, errors: [`course.json is missing or not valid JSON: ${(err as Error).message}`] }
  }
  const errors = validateManifest(manifest)
  if (errors.length) return { ok: false, errors }
  if (manifest.schema_version !== CURRENT_SCHEMA_VERSION) return { ok: false, errors: [`/schema_version: publish in format ${CURRENT_SCHEMA_VERSION}`] }
  const identity = publishedIdentityErrors(manifest)
  if (identity.length) return { ok: false, errors: identity }
  const missing = referencedAssets(manifest).filter((path) => !resolveInside(staging, path))
  if (missing.length) return { ok: false, errors: missing.slice(0, 10).map((path) => `missing asset: ${path}`) }
  const adopted = adoptPublishedManifest(manifest)
  if (!adopted.ok) return { ok: false, errors: adopted.errors }
  return { ok: true, archive: { manifest, elements: courseNodes(adopted.manifest).map((n) => ({ uid: n.id, kind: n.kind, parent: n.parentId })) } }
}
