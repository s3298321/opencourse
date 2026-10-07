/**
 * Checking what a server sent before anything acts on it or shows it.
 *
 * Every parser returns null for anything that is not the expected shape, and
 * copies only the fields it knows - an extra field a server sends never reaches
 * the renderer. Strings are capped, so a hostile server cannot fill the window
 * with a megabyte of title.
 */
import type { Account, AuthResult, CatalogCourse, CatalogPage, CatalogTag, CourseOverview, CourseStatus, ManagedCourse, OutlineModule, PublishResult, ServerInfo, VersionEntry } from './api'
import { TOKEN_PREFIX } from './api'
import { isVersion } from './semver'
import { UID } from './identity'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null)
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const opt = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.length <= max && v ? v : undefined)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const list = <T>(v: unknown, item: (x: unknown) => T | null, max = 1000): T[] | null => {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const x of v) { const parsed = item(x); if (parsed === null) return null; out.push(parsed) }
  return out
}

export function parseServerInfo(raw: unknown): ServerInfo | null {
  const o = obj(raw)
  if (!o || o['opencourse'] !== 1 || typeof o['api'] !== 'number') return null
  const name = str(o['name'], 120)
  if (!name) return null
  return { opencourse: 1, api: o['api'] as number, name, description: str(o['description'], 500) ?? '', registration: o['registration'] === 'closed' ? 'closed' : 'open' }
}

export function parseAccount(raw: unknown): Account | null {
  const o = obj(raw)
  const id = str(o?.['id'], 64), username = str(o?.['username'], 64), email = str(o?.['email'], 254)
  return id && username && email ? { id, username, email } : null
}

export function parseAuthResult(raw: unknown): AuthResult | null {
  const o = obj(raw)
  const token = str(o?.['token'], 200), account = parseAccount(o?.['account'])
  return token && token.startsWith(TOKEN_PREFIX) && account ? { token, account } : null
}

const DIFFICULTY = new Set(['beginner', 'intermediate', 'advanced'])

export function parseCatalogCourse(raw: unknown): CatalogCourse | null {
  const o = obj(raw)
  if (!o) return null
  const id = str(o['id'], 64), slug = str(o['slug'], 200), title = str(o['title'], 300), publisher = str(o['publisher'], 64), version = str(o['version'], 40), updatedAt = str(o['updatedAt'], 40)
  const tags = list(o['tags'], (t) => str(t, 60), 30)
  const downloads = num(o['downloads']), lessons = num(o['lessonCount']), projects = num(o['projectCount'])
  if (!id || !UID.test(id) || !slug || !title || !publisher || !version || !isVersion(version) || !updatedAt || !tags || downloads === null || lessons === null || projects === null) return null
  const difficulty = typeof o['difficulty'] === 'string' && DIFFICULTY.has(o['difficulty']) ? o['difficulty'] as CatalogCourse['difficulty'] : undefined
  const hours = num(o['estimatedHours'])
  return {
    id, slug, title, publisher, version, updatedAt, tags, downloads, lessonCount: lessons, projectCount: projects, hasCover: o['hasCover'] === true,
    ...(opt(o['description'], 20000) ? { description: opt(o['description'], 20000) } : {}),
    ...(opt(o['subject'], 120) ? { subject: opt(o['subject'], 120) } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(hours !== null ? { estimatedHours: hours } : {}),
    ...(opt(o['author'], 200) ? { author: opt(o['author'], 200) } : {})
  }
}

export function parseCatalogPage(raw: unknown): CatalogPage | null {
  const o = obj(raw)
  const courses = list(o?.['courses'], parseCatalogCourse, 200)
  const total = num(o?.['total']), page = num(o?.['page']), pageSize = num(o?.['pageSize'])
  return courses && total !== null && page !== null && pageSize ? { courses, total, page, pageSize } : null
}

export function parseTags(raw: unknown): CatalogTag[] | null {
  return list(obj(raw)?.['tags'], (t) => {
    const o = obj(t), tag = str(o?.['tag'], 60), count = num(o?.['count'])
    return tag && count !== null ? { tag, count } : null
  }, 200)
}

const STATUSES = new Set(['current', 'available', 'withdrawn', 'deleted'])
function parseVersionEntry(raw: unknown): VersionEntry | null {
  const o = obj(raw)
  const version = str(o?.['version'], 40), publishedAt = str(o?.['publishedAt'], 40), releaseNote = str(o?.['releaseNote'], 4000), status = o?.['status']
  if (!version || !isVersion(version) || !publishedAt || releaseNote === null || typeof status !== 'string' || !STATUSES.has(status)) return null
  const downloads = num(o?.['downloads'])
  return { version, publishedAt, releaseNote, status: status as VersionEntry['status'], ...(downloads !== null ? { downloads } : {}) }
}

function parseOutline(raw: unknown): OutlineModule | null {
  const o = obj(raw)
  const title = str(o?.['title'], 300), kind = o?.['kind']
  const lessons = list(o?.['lessons'], (l) => {
    const lo = obj(l), t = str(lo?.['title'], 300), minutes = num(lo?.['minutes'])
    return t ? (minutes !== null ? { title: t, minutes } : { title: t }) : null
  }, 500)
  return title && (kind === 'lessons' || kind === 'project') && lessons ? { title, kind, lessons } : null
}

export function parseOverview(raw: unknown): CourseOverview | null {
  const base = parseCatalogCourse(raw), o = obj(raw)
  if (!base || !o) return null
  const prerequisites = list(o['prerequisites'], (p) => str(p, 2000), 100)
  const outline = list(o['outline'], parseOutline, 500)
  const versions = list(o['versions'], parseVersionEntry, 1000)
  const counts = ['totalMinutes', 'quizCount', 'exerciseCount', 'flashcardCount'].map((k) => num(o[k]))
  if (!prerequisites || !outline || !versions || counts.some((c) => c === null)) return null
  return { ...base, prerequisites, outline, versions, totalMinutes: counts[0]!, quizCount: counts[1]!, exerciseCount: counts[2]!, flashcardCount: counts[3]!, ownedByYou: o['ownedByYou'] === true, listed: o['listed'] !== false }
}

export function parseStatuses(raw: unknown): CourseStatus[] | null {
  return list(obj(raw)?.['courses'], (c) => {
    const o = obj(c), id = str(o?.['id'], 64), current = o?.['currentVersion']
    if (!id || (current !== null && (typeof current !== 'string' || !isVersion(current)))) return null
    return { id, currentVersion: current as string | null, listed: o?.['listed'] === true }
  }, 500)
}

export function parseManagedCourse(raw: unknown): ManagedCourse | null {
  const o = obj(raw)
  const id = str(o?.['id'], 64), title = str(o?.['title'], 300), slug = str(o?.['slug'], 200), max = str(o?.['maxVersion'], 40), current = o?.['currentVersion']
  const versions = list(o?.['versions'], parseVersionEntry, 1000), downloads = num(o?.['downloads'])
  if (!id || !title || !slug || !max || !versions || downloads === null || (current !== null && (typeof current !== 'string' || !isVersion(current)))) return null
  return { id, title, slug, maxVersion: max, currentVersion: current as string | null, listed: o?.['listed'] === true, downloads, versions }
}

export function parsePublishResult(raw: unknown): PublishResult | null {
  const o = obj(raw)
  const courseId = str(o?.['courseId'], 64), version = str(o?.['version'], 40)
  return courseId && version && isVersion(version) ? { courseId, version, created: o?.['created'] === true } : null
}

/** A refusal's code and message, or null for a body that is not one. */
export function parseApiError(raw: unknown): { code: string; message: string; errors?: string[]; extra: Obj } | null {
  const e = obj(obj(raw)?.['error'])
  const code = str(e?.['code'], 60), message = str(e?.['message'], 1000)
  if (!code || !message || !e) return null
  const errors = list(e['errors'], (x) => str(x, 1000), 50)
  return { code, message, ...(errors ? { errors } : {}), extra: e }
}
