import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ContentKind, ContentRef } from '@core/learning/types'
import { buildCourse } from '@core/manifest'
import { adoptPublishedManifest } from '@core/catalog/identity'
import { resolveInside } from '@core/safepath'
import { extractArchive } from '@app/unzip'
import type { CourseManifest, Course, CourseView } from '@core/types'
import type { Ctx } from '../context'
import { notFound } from '../errors'

export interface ContentRecord {
  version: string
  title: string
  path: string
  fingerprint: string
  bytes: number
}
export function contentRecord(ctx: Ctx, accountId: string, ref: ContentRef, enrolling = false): ContentRecord {
  const d = ctx.db
  const enrolled = d
    .prepare('SELECT active FROM enrollments WHERE account_id=? AND kind=? AND content_id=?')
    .get(accountId, ref.kind, ref.id) as { active: number } | undefined
  if (ref.kind === 'course') {
    const row = d
      .prepare(
        `SELECT c.owner_id,c.unlisted_at,c.moderated_at,v.archive_path,v.sha256,v.bytes,v.overview
      FROM courses c JOIN course_versions v ON v.course_id=c.id WHERE c.id=? AND v.version=? AND v.deleted_at IS NULL`
      )
      .get(ref.id, ref.version) as
      | {
          owner_id: string
          unlisted_at: string | null
          moderated_at: string | null
          archive_path: string | null
          sha256: string
          bytes: number
          overview: string
        }
      | undefined
    if (
      !row ||
      row.moderated_at ||
      !row.archive_path ||
      (!enrolling && !enrolled?.active) ||
      (row.unlisted_at && !enrolled?.active && row.owner_id !== accountId)
    )
      throw notFound('This course version is unavailable.')
    return {
      version: ref.version,
      title: JSON.parse(row.overview).title,
      path: row.archive_path,
      fingerprint: row.sha256,
      bytes: row.bytes
    }
  }
  const row = d
    .prepare(
      `SELECT p.owner_id,p.unlisted_at,p.moderated_at,v.* FROM published_documents p JOIN document_versions v ON v.document_id=p.id
    WHERE p.id=? AND v.version=? AND v.deleted_at IS NULL`
    )
    .get(ref.id, ref.version) as Record<string, unknown> | undefined
  if (
    !row ||
    row.moderated_at ||
    !row.pdf_path ||
    (!enrolling && !enrolled?.active) ||
    (row.unlisted_at && !enrolled?.active && row.owner_id !== accountId)
  )
    throw notFound('This document version is unavailable.')
  return {
    version: ref.version,
    title: String(row.title),
    path: String(row.pdf_path),
    fingerprint: String(row.fingerprint),
    bytes: Number(row.bytes)
  }
}
export function currentVersion(ctx: Ctx, kind: ContentKind, id: string): string {
  const row = ctx.db
    .prepare(`SELECT current_version FROM ${kind === 'course' ? 'courses' : 'published_documents'} WHERE id=?`)
    .get(id) as { current_version: string } | undefined
  if (!row?.current_version) throw notFound('This content is unavailable.')
  return row.current_version
}
const extracting = new Map<string, Promise<string>>()
export async function coursePackage(ctx: Ctx, record: ContentRecord): Promise<string> {
  const root = join(ctx.config.dataDir, 'learning-packages', record.fingerprint)
  if (existsSync(join(root, 'course.json'))) return root
  const pending = extracting.get(root)
  if (pending) return pending
  const work = (async () => {
    mkdirSync(join(ctx.config.dataDir, 'learning-packages'), { recursive: true })
    const staging = `${root}.${randomUUID()}`
    try {
      const result = await extractArchive(record.path, staging)
      if (result.error) throw new Error('This course archive could not be opened.')
      renameSync(staging, root)
      return root
    } finally {
      rmSync(staging, { recursive: true, force: true })
      extracting.delete(root)
    }
  })()
  extracting.set(root, work)
  return work
}
export async function readCourse(ctx: Ctx, accountId: string, ref: ContentRef): Promise<Course> {
  const root = await coursePackage(ctx, contentRecord(ctx, accountId, ref))
  const manifest = JSON.parse(readFileSync(join(root, 'course.json'), 'utf8')) as CourseManifest
  const adopted = adoptPublishedManifest(manifest)
  if (!adopted.ok || adopted.courseId !== ref.id) throw notFound('Invalid published course.')
  return buildCourse(
    adopted.manifest,
    root,
    (path) =>
      `/api/v1/learn/course/${ref.id}/${ref.version}/assets/${path
        .replace(/^assets\//, '')
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    ref.id
  )
}
/** The browser never receives the answer key or runnable author files. */
export function learnerCourse(course: Course): CourseView {
  const copy = structuredClone(course)
  for (const module of copy.modules) {
    if (module.type === 'project') continue
    for (const lesson of module.lessons) {
      for (const card of lesson.flashcards ?? []) delete (card as Partial<typeof card>).answer
      for (const block of lesson.blocks) {
        if (block.type === 'quiz') {
          delete block.answers
          delete block.explanation
          for (const option of block.options ?? []) delete (option as Partial<typeof option>).correct
        }
        if (block.type === 'exercise') {
          delete block.solution
          delete block.expected_output
          delete block.hints
          delete (block as Partial<typeof block>).verification_instructions
        }
      }
    }
  }
  const { root: _root, ...view } = copy
  return view
}
export function courseAsset(root: string, path: string): string {
  if (!/^assets\//.test(path) || !/\.(png|jpe?g|webp|gif|svg|mp4|webm|html|css|js|woff2?)$/i.test(path))
    throw notFound()
  const file = resolveInside(root, path)
  if (!file) throw notFound()
  return file
}
