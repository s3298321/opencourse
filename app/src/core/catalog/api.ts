/**
 * The contract between the app and an OpenCourse server (server/ in this repo).
 *
 * Both sides import this file: the server builds these shapes, and the app's
 * main process checks every response against them before anything reaches the
 * renderer - a server is someone else's computer. The account rules are here
 * for the same reason the course schema is shared: the app says "that username
 * is not allowed" as you type, and the server refuses exactly the same names.
 *
 * docs/server-api.md is the prose version. Change both together.
 */
import type { Difficulty } from '../types'

export const API_VERSION = 1
export const API_PREFIX = '/api/v1'
/** Every token a server issues starts with this, so a log scrubber can find one. */
export const TOKEN_PREFIX = 'ocs_'

/* --- accounts ------------------------------------------------------------- */

export const USERNAME = /^[a-z0-9](?:[a-z0-9_-]{1,30})[a-z0-9]$/
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'opencourse', 'api', 'www', 'mail',
  'me', 'moderator', 'staff', 'owner', 'null', 'undefined', 'anonymous', 'courses', 'catalog'
])
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 256
export const CODE_LENGTH = 6

/** Null when the name is acceptable; otherwise what to tell the person typing it. */
export function usernameProblem(name: string): string | null {
  if (name.length < 3) return 'At least 3 characters.'
  if (name.length > 32) return 'At most 32 characters.'
  if (!USERNAME.test(name)) return 'Lowercase letters, digits, "-" and "_", starting and ending with a letter or digit.'
  if (RESERVED_USERNAMES.has(name)) return 'That name is reserved.'
  return null
}

export function emailProblem(email: string): string | null {
  if (email.length > 254) return 'That address is too long.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[^\s@]+@localhost$/.test(email)) return 'That does not look like an email address.'
  return null
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters.`
  if (password.length > MAX_PASSWORD) return `At most ${MAX_PASSWORD} characters.`
  return null
}

export function isCode(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)
}

/* --- shapes --------------------------------------------------------------- */

export interface ServerInfo {
  opencourse: 1
  api: number
  name: string
  description: string
  registration: 'open' | 'closed'
}

export interface Account { id: string; username: string; email: string }
export interface AuthResult { token: string; account: Account }
export interface ApiErrorBody { error: { code: string; message: string } }

/** One catalog card. Everything a list needs, nothing a learner should not see. */
export interface CatalogCourse {
  id: string
  slug: string
  title: string
  description?: string
  subject?: string
  difficulty?: Difficulty
  estimatedHours?: number
  author?: string
  tags: string[]
  /** The username of the account that published it. */
  publisher: string
  /** The current version - what adding or updating installs. */
  version: string
  /** Distinct accounts that have added the course. */
  downloads: number
  lessonCount: number
  projectCount: number
  hasCover: boolean
  updatedAt: string
}

export interface CatalogPage { courses: CatalogCourse[]; total: number; page: number; pageSize: number }
export interface CatalogTag { tag: string; count: number }
export type CatalogSort = 'downloads' | 'recent' | 'title'

/** The outline of a course: titles and counts. Never a question, an answer or a test. */
export interface OutlineModule {
  title: string
  kind: 'lessons' | 'project'
  lessons: { title: string; minutes?: number }[]
}

export type VersionStatus = 'current' | 'available' | 'withdrawn' | 'deleted'
export interface VersionEntry {
  version: string
  publishedAt: string
  releaseNote: string
  status: VersionStatus
  /** Owner only: accounts that added the course at this version. */
  downloads?: number
}

export interface CourseOverview extends CatalogCourse {
  prerequisites: string[]
  outline: OutlineModule[]
  totalMinutes: number
  quizCount: number
  exerciseCount: number
  flashcardCount: number
  versions: VersionEntry[]
  ownedByYou: boolean
  /** False only for its owner: an unpublished course is not shown to anyone else. */
  listed: boolean
}

/** What an update check needs per course. `currentVersion` null: no longer published. */
export interface CourseStatus { id: string; currentVersion: string | null; listed: boolean }

export interface PublishResult { courseId: string; version: string; created: boolean }

/** A publisher's view of one of their courses. */
export interface ManagedCourse {
  id: string
  title: string
  slug: string
  currentVersion: string | null
  maxVersion: string
  listed: boolean
  downloads: number
  versions: VersionEntry[]
}
