/**
 * Browsing a server's catalog. Read-only, and anonymous where the server
 * allows it - the token goes along only so the server can say which courses
 * are the user's own. Covers cross to the renderer as data: URLs, like
 * favicons, because `img-src` already allows them and the CSP does not move.
 */
import type { CatalogPage, CatalogSort, CatalogTag, CourseOverview } from '../core/catalog/api'
import { UID } from '../core/catalog/identity'
import { parseCatalogPage, parseOverview, parseTags } from '../core/catalog/parse'
import { sniffImage } from '../core/sidechat/favicon'
import { isVersion } from '../core/catalog/semver'
import { callServer, fetchBytes, ServerError } from './serverclient'
import { serverAccess } from './servers'
import { requireUser } from './users'

export interface CatalogQuery { q?: string; tags?: string[]; sort?: CatalogSort; page?: number }
const SORTS: ReadonlySet<string> = new Set(['downloads', 'recent', 'title'])

export async function searchCatalog(serverId: string, query: CatalogQuery = {}): Promise<CatalogPage> {
  const access = serverAccess(serverId)
  const params = new URLSearchParams()
  if (typeof query.q === 'string' && query.q.trim()) params.set('q', query.q.trim().slice(0, 200))
  for (const tag of (Array.isArray(query.tags) ? query.tags : []).slice(0, 5)) if (typeof tag === 'string' && tag) params.append('tag', tag.slice(0, 60))
  if (typeof query.sort === 'string' && SORTS.has(query.sort)) params.set('sort', query.sort)
  if (Number.isInteger(query.page) && query.page! > 1) params.set('page', String(Math.min(query.page!, 1000)))
  const search = params.toString()
  return callServer(access.url, `/courses${search ? `?${search}` : ''}`, parseCatalogPage, { token: access.token || null, route: '/courses' })
}

export async function catalogTags(serverId: string): Promise<CatalogTag[]> {
  const access = serverAccess(serverId)
  return callServer(access.url, '/tags', parseTags, { route: '/tags' })
}

export function requireCourseUid(courseId: string): string {
  if (typeof courseId !== 'string' || !UID.test(courseId)) throw new ServerError(400, 'invalid_course', 'That is not a course on this server.')
  return courseId
}

export async function catalogOverview(serverId: string, courseId: string): Promise<CourseOverview> {
  const access = serverAccess(serverId)
  return callServer(access.url, `/courses/${requireCourseUid(courseId)}`, parseOverview, { token: access.token || null, route: '/courses/:id' })
}

/** Covers of one version never change, so they are kept for the launch. */
const covers = new Map<string, string | null>()
const MAX_COVER_BYTES = 2 * 1024 * 1024

export async function catalogCover(serverId: string, courseId: string, version: string): Promise<string | null> {
  const access = serverAccess(serverId)
  if (!UID.test(String(courseId)) || !isVersion(version)) return null
  const key = `${requireUser()}|${access.url}|${courseId}|${version}`
  if (covers.has(key)) return covers.get(key)!
  let url: string | null = null
  try {
    const { bytes } = await fetchBytes(access.url, `/courses/${courseId}/cover`, MAX_COVER_BYTES, { token: access.token || null, route: '/courses/:id/cover', headers: { accept: 'image/*' } })
    const type = sniffImage(bytes)
    url = type ? `data:${type};base64,${bytes.toString('base64')}` : null
  } catch (error) {
    // A course with no cover is remembered; an outage is not.
    if (!(error instanceof ServerError) || error.status !== 404) return null
  }
  if (covers.size > 300) covers.delete(covers.keys().next().value!)
  covers.set(key, url)
  return url
}
