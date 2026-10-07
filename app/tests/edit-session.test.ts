// @vitest-environment node
/**
 * The course editor writes nothing to a course until Save - not the author's
 * edits, not the assistant's, and not an upload's record. These tests watch the
 * disk rather than the API, because "the draft is not in document.json" is
 * exactly the kind of promise an API can keep while a file quietly changes.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { CourseManifest } from '../src/core/types'
import { identifyManifest } from '../src/core/course-document'
import { projectCourse } from './helpers/project'
import { installCourseFixture } from './helpers/course'

const root = mkdtempSync(join(tmpdir(), 'opencourse-edit-session-'))
let dataDir = join(root, 'data'), serial = 0
vi.mock('electron', () => ({ app: { getPath: () => dataDir, getAppPath: () => resolve('.'), on: () => {} }, dialog: {} }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => 'sk-test' }))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))
vi.mock('../src/main/chattitles', () => ({ cancelChatTitles: () => {}, generateChatTitle: async () => {} }))
vi.mock('../src/main/openai', () => ({ streamChat: vi.fn() }))
const { createUser } = await import('../src/main/users')
const { closeDb, db } = await import('../src/main/db')
const { listCourses, reloadCourses } = await import('../src/main/courses')
const { createCourse, discardCourseDraft, getAuthoringCourse, isEditSessionDirty, openEditSession, releaseEditSessions, saveCourse, saveDraft, uploadCourseAttachmentPath } = await import('../src/main/course-authoring')
const { atomicJSON, courseDirectory, ensureCourseStorage, packageDirectory, readDocument } = await import('../src/main/course-store')
const { editSession, removeEditSession, SESSION_JOURNAL } = await import('../src/main/edit-sessions')
const { beginAuthoringTurn } = await import('../src/main/authoring-state')
const { runAuthoringTool } = await import('../src/main/authoring-tools')
const { createAuthoringChat, listAuthoringChats } = await import('../src/main/authoring-chat')

let userId = ''
beforeEach(() => { closeDb(); dataDir = join(root, `data-${++serial}`); userId = createUser('Author').id; reloadCourses() })
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })

/** Every file under a course directory, with its bytes. */
function snapshot(courseId: string): Record<string, string> {
  const base = courseDirectory(courseId), out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[relative(base, path)] = readFileSync(path, 'base64')
    }
  }
  walk(base)
  return out
}
function edit(courseId: string, change: (manifest: CourseManifest) => void) {
  const { document, draft } = getAuthoringCourse(courseId)
  const next = structuredClone(draft.manifest); change(next)
  const result = saveDraft(courseId, next, document.revision, draft.draftVersion)
  if ('status' in result) throw new Error('Unexpected conflict')
  return result
}
async function tool(courseId: string, name: string, args: unknown) {
  const lease = beginAuthoringTurn(courseId, 'test', () => {})
  try { return JSON.parse(await runAuthoringTool(courseId, name, args, lease.token, new AbortController().signal)) } finally { lease.release() }
}
function picture(): string { const path = join(root, `picture-${serial}.png`); writeFileSync(path, 'png bytes'); return path }

describe('edits stay in the session until Save', () => {
  it('writes nothing to the course for a manual edit or an assistant edit', async () => {
    const course = installCourseFixture(projectCourse()), before = snapshot(course.courseId)
    edit(course.courseId, (m) => { m.title = 'Edited by hand' })
    expect(snapshot(course.courseId)).toEqual(before)
    const lesson = getAuthoringCourse(course.courseId).draft.manifest.modules[0].lessons![0].nodeId!
    expect((await tool(course.courseId, 'update_element', { ref: lesson, fields: { title: 'Edited by the assistant' } })).ok).toBe(true)
    expect(snapshot(course.courseId)).toEqual(before)
    expect(readDocument(course.courseId).manifest!.title).toBe('Project course')
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('Edited by hand')
  })

  it('is dirty while it differs from the saved course, including an edit undone by hand', async () => {
    const course = installCourseFixture(projectCourse())
    expect(getAuthoringCourse(course.courseId).draft.dirty).toBe(false)
    expect(edit(course.courseId, (m) => { m.title = 'Changed' }).dirty).toBe(true)
    expect(isEditSessionDirty(course.courseId)).toBe(true)
    expect(edit(course.courseId, (m) => { m.title = 'Project course' }).dirty).toBe(false)
    const saved = edit(course.courseId, (m) => { m.title = 'Kept' })
    expect(await saveCourse(course.courseId, course.revision, saved.draftVersion)).toMatchObject({ status: 'ok' })
    expect(getAuthoringCourse(course.courseId).draft.dirty).toBe(false)
    expect(readDocument(course.courseId).manifest!.title).toBe('Kept')
  })

  it('discards edits and uploads, and leaves the saved course byte for byte', async () => {
    const course = installCourseFixture(projectCourse()), before = snapshot(course.courseId)
    const upload = await uploadCourseAttachmentPath(course.courseId, picture(), 'image')
    edit(course.courseId, (m) => { m.cover_image = upload.attachment.entry })
    expect(existsSync(join(packageDirectory(course.courseId), upload.attachment.entry))).toBe(true)
    expect(readDocument(course.courseId).attachments).toEqual([])
    expect(getAuthoringCourse(course.courseId).document.attachments.map((a) => a.id)).toEqual([upload.attachment.id])
    expect(discardCourseDraft(course.courseId)).toEqual({ removed: false })
    expect(snapshot(course.courseId)).toEqual(before)
    expect(getAuthoringCourse(course.courseId).draft.manifest.cover_image).toBeUndefined()
  })

  it('records an upload only when the course is saved', async () => {
    const course = installCourseFixture(projectCourse())
    const upload = await uploadCourseAttachmentPath(course.courseId, picture(), 'image')
    const saved = edit(course.courseId, (m) => { m.cover_image = upload.attachment.entry })
    expect(await saveCourse(course.courseId, course.revision, saved.draftVersion)).toMatchObject({ status: 'ok' })
    expect(readDocument(course.courseId).attachments.map((a) => a.id)).toEqual([upload.attachment.id])
    expect(existsSync(join(courseDirectory(course.courseId), SESSION_JOURNAL))).toBe(false)
  })

  it('cleans up after a crash: a stale journal loses its uploads', async () => {
    const course = installCourseFixture(projectCourse()), before = snapshot(course.courseId)
    await uploadCourseAttachmentPath(course.courseId, picture(), 'image')
    removeEditSession(userId, course.courseId) // what a process exit does to memory
    ensureCourseStorage()
    expect(snapshot(course.courseId)).toEqual(before)
  })
})

describe('a new course', () => {
  it('has no document and no library card until its first save', async () => {
    const created = createCourse(), id = created.document.courseId
    expect(existsSync(join(courseDirectory(id), 'document.json'))).toBe(false)
    expect(listCourses().map((c) => c.courseId)).not.toContain(id)
    expect(getAuthoringCourse(id).draft.dirty).toBe(false)
    const saved = edit(id, (m) => { Object.assign(m, identifyManifest(projectCourse(), randomUUID)) })
    expect(saved.dirty).toBe(true)
    expect(await saveCourse(id, 0, saved.draftVersion)).toMatchObject({ status: 'ok', revision: 1 })
    expect(listCourses().map((c) => c.courseId)).toContain(id)
    expect(existsSync(join(courseDirectory(id), SESSION_JOURNAL))).toBe(false)
  })

  it('is removed with its assistant chats when discarded, or when a crash orphaned it', () => {
    const first = createCourse().document.courseId
    createAuthoringChat(first)
    expect(discardCourseDraft(first)).toEqual({ removed: true })
    expect(existsSync(courseDirectory(first))).toBe(false)
    expect(db().prepare('SELECT COUNT(*) AS n FROM authoring_chats').get()).toMatchObject({ n: 0 })

    const second = createCourse().document.courseId
    createAuthoringChat(second)
    removeEditSession(userId, second)
    ensureCourseStorage()
    expect(existsSync(courseDirectory(second))).toBe(false)
    expect(db().prepare('SELECT COUNT(*) AS n FROM library_courses WHERE id=?').get(second)).toMatchObject({ n: 0 })
  })

  it('goes away with the window that was creating it', () => {
    const id = createCourse().document.courseId
    openEditSession(id, 7)
    edit(id, (m) => { m.title = 'Half written' })
    releaseEditSessions(7)
    expect(editSession(userId, id)).toBeUndefined()
    expect(existsSync(courseDirectory(id))).toBe(false)
  })
})

describe('an editor window', () => {
  it('keeps the session while another window still holds it', () => {
    const course = installCourseFixture(projectCourse())
    openEditSession(course.courseId, 1); openEditSession(course.courseId, 2)
    edit(course.courseId, (m) => { m.title = 'Shared edit' })
    releaseEditSessions(1)
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('Shared edit')
    releaseEditSessions(2)
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('Project course')
  })

  it('adopts an autosaved draft from an earlier build once, as unsaved changes', () => {
    const course = installCourseFixture(projectCourse())
    const legacy = { courseId: course.courseId, baseRevision: course.revision, draftVersion: 4, manifest: { ...readDocument(course.courseId).manifest!, title: 'From the old autosave' } }
    atomicJSON(join(courseDirectory(course.courseId), 'draft.json'), legacy)
    const opened = openEditSession(course.courseId, 3)
    expect(opened.draft).toMatchObject({ draftVersion: 4, dirty: true })
    expect(opened.draft.manifest.title).toBe('From the old autosave')
    discardCourseDraft(course.courseId)
    expect(existsSync(join(courseDirectory(course.courseId), 'draft.json'))).toBe(false)
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('Project course')
    expect(listAuthoringChats(course.courseId)).toEqual([])
  })
})
