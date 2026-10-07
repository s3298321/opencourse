/**
 * The catalog as queries. A course is listed when it has a current version, its
 * owner has not unpublished it and no moderator has removed it; everything a
 * stranger can see goes through `LISTED` and `isListed` below, so an unlisted
 * course cannot leak through a side door.
 */
import type { Account, CatalogCourse, CatalogPage, CatalogSort, CatalogTag, CourseOverview, CourseStatus, ManagedCourse, VersionEntry, VersionStatus } from '@core/catalog/api'
import { compareVersions } from '@core/catalog/semver'
import type { Db } from '../db'
import { searchFields, type StoredOverview } from './overview'

export const PAGE_SIZE = 24
const LISTED = 'c.unlisted_at IS NULL AND c.moderated_at IS NULL AND c.current_version IS NOT NULL'

interface CourseRow {
  id: string
  owner_id: string
  publisher: string
  current_version: string | null
  max_version: string
  updated_at: string
  unlisted_at: string | null
  moderated_at: string | null
  moderation_reason: string
  overview: string | null
  downloads: number
}

/** Shown to anyone: published, not unpublished by its owner, not removed by a moderator. */
const isListed = (row: CourseRow): boolean => row.unlisted_at === null && row.moderated_at === null && row.current_version !== null

const SELECT_COURSE = `SELECT c.id, c.owner_id, a.username AS publisher, c.current_version, c.max_version, c.updated_at, c.unlisted_at, c.moderated_at, c.moderation_reason, v.overview,
  (SELECT COUNT(DISTINCT q.account_id) FROM acquisitions q WHERE q.course_id = c.id AND q.kind = 'add') AS downloads
  FROM courses c JOIN accounts a ON a.id = c.owner_id
  LEFT JOIN course_versions v ON v.course_id = c.id AND v.version = c.current_version`

function card(row: CourseRow): CatalogCourse {
  const o = JSON.parse(row.overview ?? '{}') as StoredOverview
  return {
    id: row.id, slug: o.slug, title: o.title,
    ...(o.description ? { description: o.description } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.difficulty ? { difficulty: o.difficulty } : {}),
    ...(o.estimatedHours !== undefined ? { estimatedHours: o.estimatedHours } : {}),
    ...(o.author ? { author: o.author } : {}),
    tags: o.tags ?? [], publisher: row.publisher, version: row.current_version ?? '', downloads: Number(row.downloads),
    lessonCount: o.lessonCount ?? 0, projectCount: o.projectCount ?? 0, hasCover: Boolean(o.hasCover), updatedAt: row.updated_at
  }
}

/**
 * Words become quoted prefix terms, so "intro llvm" finds "Introduction to
 * LLVM" and nothing typed can be FTS5 syntax. Every term must match.
 */
export function ftsQuery(q: string): string | null {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? []
  return terms.length ? terms.map((t) => `"${t}"*`).join(' ') : null
}

export function catalogPage(d: Db, options: { q?: string; tags?: string[]; sort?: CatalogSort; page?: number }): CatalogPage {
  const page = Math.max(1, Math.min(1000, Math.floor(options.page ?? 1)))
  const where = [LISTED]
  const params: (string | number)[] = []
  let join = ''
  const match = options.q ? ftsQuery(options.q) : null
  if (match) {
    join = 'JOIN (SELECT course_id, bm25(course_search) AS rank FROM course_search WHERE course_search MATCH ?) s ON s.course_id = c.id'
    params.push(match)
  }
  for (const tag of (options.tags ?? []).slice(0, 5)) {
    where.push('c.id IN (SELECT course_id FROM course_tags WHERE tag = ?)')
    params.push(tag.trim().toLowerCase())
  }
  const order = options.sort === 'recent' ? 'c.updated_at DESC'
    : options.sort === 'title' ? "json_extract(v.overview, '$.title') COLLATE NOCASE"
    : options.sort === 'downloads' || !match ? 'downloads DESC, c.updated_at DESC'
    : 's.rank'
  const base = `${SELECT_COURSE} ${join} WHERE ${where.join(' AND ')}`
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params) as { n: number }).n)
  const rows = d.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as CourseRow[]
  return { courses: rows.map(card), total, page, pageSize: PAGE_SIZE }
}

/** Every listed course, for the sitemap. */
export function listedCourses(d: Db): { id: string; updatedAt: string }[] {
  return (d.prepare(`SELECT c.id, c.updated_at FROM courses c WHERE ${LISTED} ORDER BY c.updated_at DESC LIMIT 50000`).all() as { id: string; updated_at: string }[])
    .map((row) => ({ id: row.id, updatedAt: row.updated_at }))
}

export function tagCounts(d: Db): CatalogTag[] {
  return (d.prepare(`SELECT t.tag, COUNT(*) AS count FROM course_tags t JOIN courses c ON c.id = t.course_id
    WHERE ${LISTED} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 60`).all() as { tag: string; count: number }[])
    .map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

function courseRow(d: Db, id: string): CourseRow | undefined {
  return d.prepare(`${SELECT_COURSE} WHERE c.id = ?`).get(id) as CourseRow | undefined
}

/** Listed, or the viewer's own. Everything else does not exist, as far as the viewer can tell. */
export function visibleCourse(d: Db, id: string, viewer: Account | null): CourseRow | null {
  const row = courseRow(d, id)
  if (!row) return null
  if (row.owner_id === viewer?.id) return row.current_version ? row : null
  return isListed(row) ? row : null
}

interface VersionRow { version: string; published_at: string; release_note: string; deleted_at: string | null; downloads: number }

function versionEntries(d: Db, row: CourseRow, owner: boolean): VersionEntry[] {
  const rows = d.prepare(`SELECT v.version, v.published_at, v.release_note, v.deleted_at,
    (SELECT COUNT(DISTINCT q.account_id) FROM acquisitions q WHERE q.course_id = v.course_id AND q.version = v.version AND q.kind = 'add') AS downloads
    FROM course_versions v WHERE v.course_id = ? ORDER BY v.major DESC, v.minor DESC, v.patch DESC`).all(row.id) as unknown as VersionRow[]
  return rows.filter((v) => owner || !v.deleted_at).map((v) => {
    const status: VersionStatus = v.deleted_at ? 'deleted' : v.version === row.current_version ? 'current'
      : row.current_version && compareVersions(v.version, row.current_version) > 0 ? 'withdrawn' : 'available'
    return { version: v.version, publishedAt: v.published_at, releaseNote: v.release_note, status, ...(owner ? { downloads: Number(v.downloads) } : {}) }
  }).filter((v) => owner || v.status !== 'withdrawn')
}

export function courseOverview(d: Db, id: string, viewer: Account | null): CourseOverview | null {
  const row = visibleCourse(d, id, viewer)
  if (!row) return null
  const o = JSON.parse(row.overview ?? '{}') as StoredOverview
  const owner = row.owner_id === viewer?.id
  return {
    ...card(row),
    prerequisites: o.prerequisites ?? [], outline: o.outline ?? [], totalMinutes: o.totalMinutes ?? 0,
    quizCount: o.quizCount ?? 0, exerciseCount: o.exerciseCount ?? 0, flashcardCount: o.flashcardCount ?? 0,
    versions: versionEntries(d, row, owner), ownedByYou: owner, listed: isListed(row)
  }
}

export function courseStatuses(d: Db, ids: string[], viewer: Account | null): CourseStatus[] {
  const out: CourseStatus[] = []
  for (const id of ids.slice(0, 500)) {
    const row = courseRow(d, id)
    if (!row) continue
    const visible = row.owner_id === viewer?.id || isListed(row)
    out.push({ id, currentVersion: visible ? row.current_version : null, listed: isListed(row) })
  }
  return out
}

export function managedCourse(d: Db, id: string, owner: Account): ManagedCourse | null {
  const row = courseRow(d, id)
  if (!row || row.owner_id !== owner.id) return null
  const latest = d.prepare('SELECT overview FROM course_versions WHERE course_id = ? ORDER BY major DESC, minor DESC, patch DESC LIMIT 1').get(id) as { overview: string }
  const o = JSON.parse(row.overview ?? latest.overview) as StoredOverview
  return {
    id, title: o.title, slug: o.slug, currentVersion: row.current_version, maxVersion: row.max_version,
    listed: isListed(row), downloads: Number(row.downloads), versions: versionEntries(d, row, true),
    moderation: row.moderated_at ? { at: row.moderated_at, reason: row.moderation_reason } : null,
    updatedAt: row.updated_at, hasCover: Boolean(o.hasCover) && row.current_version !== null
  }
}

export function ownedCourses(d: Db, owner: Account): ManagedCourse[] {
  const ids = d.prepare('SELECT id FROM courses WHERE owner_id = ? ORDER BY updated_at DESC').all(owner.id) as { id: string }[]
  return ids.map((row) => managedCourse(d, row.id, owner)!).filter(Boolean)
}

/** Rebuilds a course's tags and search text from its current version, or removes them. */
export function refreshListing(d: Db, id: string): void {
  d.prepare('DELETE FROM course_tags WHERE course_id = ?').run(id)
  d.prepare('DELETE FROM course_search WHERE course_id = ?').run(id)
  const row = courseRow(d, id)
  if (!row || !isListed(row) || !row.overview) return
  const overview = JSON.parse(row.overview) as StoredOverview
  for (const tag of new Set(overview.tags.map((t) => t.toLowerCase()))) d.prepare('INSERT INTO course_tags(course_id, tag) VALUES (?, ?)').run(id, tag)
  const f = searchFields(overview, row.publisher)
  d.prepare('INSERT INTO course_search(course_id, title, description, subject, author, publisher, tags, outline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, f.title, f.description, f.subject, f.author, f.publisher, f.tags, f.outline)
}

export function recordAcquisition(d: Db, courseId: string, accountId: string, version: string, kind: 'add' | 'update'): void {
  d.prepare('INSERT INTO acquisitions(course_id, account_id, version, kind, at) VALUES (?, ?, ?, ?, ?)').run(courseId, accountId, version, kind, new Date().toISOString())
}
