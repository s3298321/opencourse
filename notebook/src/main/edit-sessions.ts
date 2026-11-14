/**
 * What the course editor is holding that has not been saved.
 *
 * Nothing an author does in the editor - by hand or through the assistant - is
 * written to the course until Save. The working copy lives here, in memory,
 * one per user and course, and the editor's own pushes and every authoring tool
 * meet in it (course-authoring.ts `saveDraft`). Leaving the editor without
 * saving drops it.
 *
 * Two things still touch the disk before a save, and neither is the course:
 * an upload is written to its immutable package path so the preview can serve
 * it, and a brand-new course has a placeholder directory to hold those
 * uploads. Both are listed in `edit-session.json`, the journal that
 * `ensureCourseStorage` uses to clean up after a crash - a session cannot
 * outlive the process, so a journal with no live session is always stale.
 *
 * This module is only the registry. It imports nothing that touches a course,
 * so course-store.ts can ask it whether a directory is a live placeholder.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, CourseDocument } from '../core/course-document'
import type { CourseManifest } from '../core/types'

export const SESSION_JOURNAL = 'edit-session.json'

export interface EditJournal {
  /** A course that has never been saved: discarding it removes it entirely. */
  new: boolean
  /** Package-relative files written by uploads in this session. */
  uploads: string[]
}

export interface EditSession {
  userId: string
  courseId: string
  /** The saved document when the session began; virtual for a new course. */
  document: CourseDocument
  baseRevision: number
  draftVersion: number
  manifest: CourseManifest
  /** Canonical JSON of what "nothing changed" means for this session. */
  baseline: string
  isNew: boolean
  /** A draft.json from an earlier build was adopted and is removed on save or discard. */
  legacyDraft: boolean
  uploads: Attachment[]
  /** Authoring chats that sent a message in this session. */
  chatIds: Set<string>
  /** webContents ids of the editors holding the session open. */
  holders: Set<number>
}

const sessions = new Map<string, EditSession>()
const key = (userId: string, courseId: string): string => `${userId}/${courseId}`

/** Sorted keys, so a field edited and then restored reads as unchanged. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

export function editSession(userId: string, courseId: string): EditSession | undefined {
  return sessions.get(key(userId, courseId))
}

export function putEditSession(session: EditSession): EditSession {
  sessions.set(key(session.userId, session.courseId), session)
  return session
}

export function removeEditSession(userId: string, courseId: string): void {
  sessions.delete(key(userId, courseId))
}

export function userEditSessions(userId: string): EditSession[] {
  return [...sessions.values()].filter((s) => s.userId === userId)
}

export function sessionsHeldBy(holder: number): EditSession[] {
  return [...sessions.values()].filter((s) => s.holders.has(holder))
}

export function isSessionDirty(session: EditSession): boolean {
  return session.uploads.length > 0 || canonicalJSON(session.manifest) !== session.baseline
}

/** Whether any user has unsaved course edits - which quitting now would lose. */
export function anySessionDirty(): boolean {
  return [...sessions.values()].some(isSessionDirty)
}

export function readJournal(courseRoot: string): EditJournal | null {
  const path = join(courseRoot, SESSION_JOURNAL)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<EditJournal>
    return { new: raw.new === true, uploads: Array.isArray(raw.uploads) ? raw.uploads.filter((p): p is string => typeof p === 'string') : [] }
  } catch {
    // A journal cut short by a crash still means "this session is stale".
    return { new: false, uploads: [] }
  }
}

export function removeJournal(courseRoot: string): void {
  rmSync(join(courseRoot, SESSION_JOURNAL), { force: true })
}
