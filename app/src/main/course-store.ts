import { importedAttachments } from './assets'
/** App-local authoring documents, recoverable cross-store commits, and legacy adoption. */
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import type { Attachment, CourseDocument, CourseDraft } from '../core/course-document'
import { courseNodes, identifyManifest, portableManifest, UUID } from '../core/course-document'
import { validateManifest } from '../core/schema'
import type { CourseManifest, CourseProgress } from '../core/types'
import { emptyProgress } from '../core/progress'
import { assertSafeSegment } from '../core/scaffold'
import { resolveInside } from '../core/safepath'
import { db, tx } from './db'
import { registerDocument } from './course-registry'
import { assertOwnedProjectAncestors } from './projectfiles'
import { courseProjectStateDir, courseProjectsRoot, dataRoot, userCoursesDir, userDir, userProgressDir, userWorkspaceRoot } from './paths'
import { requireUser } from './users'
import { editSession, readJournal, SESSION_JOURNAL } from './edit-sessions'

export function courseDirectory(courseId: string, userId = requireUser()): string {
  if (!UUID.test(courseId)) throw new Error('Invalid course UUID.')
  const root = join(userCoursesDir(userId), courseId)
  assertOwnedProjectAncestors(dataRoot(), root)
  return root
}
export function packageDirectory(courseId: string): string { return join(courseDirectory(courseId), 'package') }

function syncDirectory(path: string): void {
  while (!existsSync(path)) path = dirname(path)
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function atomicJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  syncDirectory(dirname(path))
}

export function readDocument(courseId: string): CourseDocument {
  const path = join(courseDirectory(courseId), 'document.json')
  // A course that has never been saved has no document yet - only the editor
  // session that is creating it, and a placeholder directory for its uploads.
  if (!existsSync(path)) {
    const session = editSession(requireUser(), courseId)
    if (session?.isNew) return structuredClone(session.document)
  }
  if (!resolveInside(courseDirectory(courseId), 'document.json')) throw new Error('Unknown course.')
  const document = JSON.parse(readFileSync(path, 'utf8')) as CourseDocument
  if (document.version !== 1 || document.courseId !== courseId || !Number.isInteger(document.revision) || document.revision < 0) throw new Error('Invalid local course document.')
  return document
}

/** A draft.json written by a build that autosaved drafts; adopted once by the editor. */
export function readLegacyDraft(document: CourseDocument): CourseDraft | null {
  const path = join(courseDirectory(document.courseId), 'draft.json')
  if (!existsSync(path)) return null
  if (!resolveInside(courseDirectory(document.courseId), 'draft.json')) throw new Error('Invalid draft location.')
  const draft = JSON.parse(readFileSync(path, 'utf8')) as CourseDraft
  if (draft.courseId !== document.courseId || !Number.isInteger(draft.draftVersion)) throw new Error('Invalid course draft.')
  return draft
}

interface Operation {
  id: string
  courseId: string
  document: CourseDocument | null
  progress: CourseProgress | null
  cleanup: string[]
  /** A server update: `package.next` replaces `package` as part of the commit. */
  packageSwap?: boolean
}

function finishOperation(operation: Operation, userId: string): void {
  const root = courseDirectory(operation.courseId, userId)
  if (operation.document) atomicJSON(join(root, 'document.json'), operation.document)
  if (operation.progress) atomicJSON(join(userProgressDir(userId), `${operation.courseId}.json`), operation.progress)
  // Idempotent: a retry after the rename finds no staged package and moves on.
  if (operation.packageSwap && existsSync(join(root, 'package.next'))) {
    rmSync(join(root, 'package'), { recursive: true, force: true })
    renameSync(join(root, 'package.next'), join(root, 'package'))
    syncDirectory(root)
  }
  for (const rel of operation.cleanup) {
    const target = join(userDir(userId), rel)
    // Journal paths are only relative paths inside this user, including nonexistent leaves.
    if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) throw new Error('Invalid recovery cleanup path.')
    assertOwnedProjectAncestors(dataRoot(), dirname(target))
    rmSync(target, { recursive: true, force: true })
    syncDirectory(dirname(target))
  }
  rmSync(join(root, 'operation.json'), { force: true })
  syncDirectory(root)
  db().prepare('DELETE FROM course_operations WHERE id=?').run(operation.id)
}

export function recoverCourseOperation(courseId: string, userId = requireUser()): void {
  const path = join(courseDirectory(courseId, userId), 'operation.json')
  if (!existsSync(path)) return
  if (!resolveInside(courseDirectory(courseId, userId), 'operation.json')) throw new Error('Invalid recovery journal.')
  const operation = JSON.parse(readFileSync(path, 'utf8')) as Operation
  if (operation.courseId !== courseId || !UUID.test(operation.id)) throw new Error('Invalid recovery operation.')
  const committed = db().prepare('SELECT id FROM course_operations WHERE id=? AND course_id=?').get(operation.id, courseId)
  if (committed) finishOperation(operation, userId)
  else {
    // Nothing outside immutable staging changed before COMMIT.
    if (operation.packageSwap) rmSync(join(courseDirectory(courseId, userId), 'package.next'), { recursive: true, force: true })
    rmSync(path, { force: true })
  }
}

export function commitCourseOperation(document: CourseDocument | null, progress: CourseProgress | null, courseId: string, cleanupPaths: string[], mutate: Parameters<typeof tx>[0], options: { packageSwap?: boolean } = {}): void {
  const userId = requireUser()
  for (const path of cleanupPaths) {
    const rel = relative(userDir(userId), path)
    if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) throw new Error('Invalid cleanup ownership.')
    assertOwnedProjectAncestors(dataRoot(), dirname(path))
  }
  const operation: Operation = { id: randomUUID(), courseId, document, progress, cleanup: cleanupPaths.map((p) => relative(userDir(userId), p)), ...(options.packageSwap ? { packageSwap: true } : {}) }
  atomicJSON(join(courseDirectory(courseId), 'operation.json'), operation)
  tx((d) => {
    mutate(d)
    d.prepare('INSERT INTO course_operations(id,course_id,revision) VALUES(?,?,?)').run(operation.id, courseId, document?.revision ?? -1)
  })
  finishOperation(operation, userId)
}

interface Migration { courseId: string; legacySlug: string; manifest: CourseManifest | null; attachments?: Attachment[]; recoveryNotes?: string[]; error?: string; complete?: boolean }
const migrating = new Set<string>()
function move(from: string, to: string): void {
  if (!existsSync(from)) return
  if (existsSync(to)) throw new Error(`Migration destination already exists: ${to}`)
  assertOwnedProjectAncestors(dataRoot(), dirname(from))
  assertOwnedProjectAncestors(dataRoot(), dirname(to))
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

/** Never infer identity after mutation: the persisted mapping is reused on every retry. */
export function migrateLegacyCourses(userId = requireUser()): void {
  if (migrating.has(userId)) return
  migrating.add(userId)
  try {
    const courses = userCoursesDir(userId)
    if (!existsSync(courses)) return
    const recovery = join(userDir(userId), '.course-migration')
    const old = readdirSync(courses).filter((name) => !name.startsWith('.') && existsSync(join(courses, name, 'course.json')) && !existsSync(join(courses, name, 'document.json')))
    const pending = existsSync(recovery) ? readdirSync(recovery).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []
    for (const slug of new Set([...old, ...pending])) {
      assertSafeSegment(slug, 'legacy course directory')
      const journal = join(recovery, `${slug}.json`)
      let mapping: Migration
      if (existsSync(journal)) mapping = JSON.parse(readFileSync(journal, 'utf8')) as Migration
      else {
        const source = join(courses, slug)
        assertOwnedProjectAncestors(dataRoot(), source)
        let manifest: CourseManifest | null = null
        let error: string | undefined
        try {
          const parsed = JSON.parse(readFileSync(join(source, 'course.json'), 'utf8')) as CourseManifest
          const errors = validateManifest(parsed)
          if (errors.length) error = errors.join('; ')
          else manifest = identifyManifest(parsed, randomUUID)
        } catch (err) { error = (err as Error).message }
        mapping = { courseId: randomUUID(), legacySlug: slug, manifest, attachments: importedAttachments(source, manifest), error }
        atomicJSON(journal, mapping)
      }
      if (mapping.complete) continue
      const backup = join(recovery, 'coach-before.db')
      if (!existsSync(backup)) db().prepare('VACUUM INTO ?').run(backup)
      if (!mapping.attachments) {
        const source = [join(courses, slug), join(courses, mapping.courseId, 'package'), join(recovery, `${slug}.package`)].find(existsSync)
        mapping.attachments = source ? importedAttachments(source, mapping.manifest) : []
        atomicJSON(journal, mapping)
      }
      const root = courseDirectory(mapping.courseId, userId)
      mkdirSync(root, { recursive: true })
      const document: CourseDocument = { version: 1, courseId: mapping.courseId, revision: 1, manifest: mapping.manifest, attachments: mapping.attachments, legacySlug: slug, recoveryNotes: mapping.recoveryNotes, ...(mapping.error ? { error: mapping.error } : {}) }
      if (!existsSync(join(root, 'package'))) {
        const pending = join(root, 'package.pending')
        rmSync(pending, { recursive: true, force: true })
        cpSync(join(courses, slug), pending, { recursive: true, dereference: false })
        renameSync(pending, join(root, 'package'))
      }
      const manifest = mapping.manifest
      const projectMap = new Map<string, string>()
      const lessons = new Map<string, { moduleId: string; lessonId: string }>()
      const ambiguousLessons = new Set<string>()
      const quizMap = new Map<string, string[]>()
      const exerciseMap = new Map<string, string[]>()
      const options = new Map<string, Map<string, string>>()
      if (manifest) for (const mod of manifest.modules) {
        if (mod.type === 'project') { projectMap.set(mod.slug, mod.nodeId!); continue }
        for (const lesson of mod.lessons) {
          const key = `${mod.slug}/${lesson.slug}`
          if (lessons.has(key) || ambiguousLessons.has(key)) {
            lessons.delete(key); ambiguousLessons.add(key)
            ;(document.recoveryNotes ??= []).push(`Ambiguous lesson and workspace: ${key}`)
          } else lessons.set(key, { moduleId: mod.nodeId!, lessonId: lesson.nodeId! })
          for (const block of lesson.blocks) {
            if (block.type !== 'quiz' && block.type !== 'exercise') continue
            const map = block.type === 'quiz' ? quizMap : exerciseMap
            map.set(block.id, [...(map.get(block.id) ?? []), block.nodeId!])
            if (block.type === 'quiz') options.set(block.nodeId!, new Map(block.options?.map((o) => [o.id, o.nodeId!])))
          }
        }
      }
      const progressPath = join(userProgressDir(userId), `${slug}.json`)
      const newProgress = join(userProgressDir(userId), `${mapping.courseId}.json`)
      if (!existsSync(newProgress) && existsSync(progressPath)) {
        const raw = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>
        cpSync(progressPath, join(recovery, `${slug}.progress.json.bak`))
        const result: CourseProgress = { ...emptyProgress(mapping.courseId), ...(typeof raw.lastAccessed === 'string' ? { lastAccessed: raw.lastAccessed } : {}) }
        const unlinked: string[] = [...(document.recoveryNotes ?? [])]
        result.completedLessons = (Array.isArray(raw.completedLessons) ? raw.completedLessons : []).flatMap((key) => {
          const lesson = lessons.get(String(key))
          if (!lesson) unlinked.push(`Completion: ${key}`)
          return lesson?.lessonId ?? []
        })
        for (const [oldField, newField] of [['quizAttempts', 'quizAttempts'], ['exercises', 'exercises']] as const) {
          const map = newField === 'quizAttempts' ? quizMap : exerciseMap
          const entries = raw[oldField] as Record<string, unknown> | undefined
          for (const [id, value] of Object.entries(entries ?? {})) {
            const matches = map.get(id)
            if (matches?.length !== 1) { unlinked.push(`${newField}: ${id}`); continue } // Original values remain backed up.
            const localId = matches[0]
            if (newField === 'quizAttempts') {
              const attempt = value as CourseProgress['quizAttempts'][string]
              result.quizAttempts[localId] = { ...attempt, submitted: attempt.submitted.map((v) => options.get(localId)?.get(v) ?? v) }
            } else result.exercises[localId] = value as CourseProgress['exercises'][string]
          }
        }
        for (const [id, value] of Object.entries((raw.projects ?? {}) as Record<string, unknown>)) {
          const localId = projectMap.get(id)
          if (!localId) unlinked.push(`Project: ${id}`)
          if (localId) result.projects[localId] = value as CourseProgress['projects'][string]
        }
        const lastLesson = raw.lastLesson as { moduleSlug?: string; lessonSlug?: string; moduleId?: string; lessonId?: string } | undefined
        if (lastLesson) result.lastLesson = lessons.get(`${lastLesson.moduleSlug ?? lastLesson.moduleId}/${lastLesson.lessonSlug ?? lastLesson.lessonId}`)
        const lastItem = raw.lastItem as typeof lastLesson & { kind?: string } | undefined
        if (lastItem?.kind === 'project') {
          const id = projectMap.get(String(lastItem.moduleSlug ?? lastItem.moduleId))
          if (id) result.lastItem = { kind: 'project', moduleId: id }
        } else if (lastItem || lastLesson) {
          const ref = lastItem ?? lastLesson!
          const mapped = lessons.get(`${ref.moduleSlug ?? ref.moduleId}/${ref.lessonSlug ?? ref.lessonId}`)
          if (mapped) result.lastItem = { kind: 'lesson', ...mapped }
        }
        if (unlinked.length) {
          mapping.recoveryNotes = unlinked; document.recoveryNotes = unlinked
          atomicJSON(journal, mapping)
        }
        atomicJSON(newProgress, result)
      }
      // Move whole namespaces once, then rehome exercise/project children by their persisted IDs.
      const workspace = join(userWorkspaceRoot(userId), mapping.courseId)
      move(join(userWorkspaceRoot(userId), slug), workspace)
      if (manifest) for (const mod of manifest.modules) {
        if (mod.type === 'project') continue
        for (const lesson of mod.lessons) for (const block of lesson.blocks) if (block.type === 'exercise') {
          if (ambiguousLessons.has(`${mod.slug}/${lesson.slug}`)) continue
          move(join(workspace, mod.slug, lesson.slug, block.id), join(workspace, 'exercises', block.nodeId!))
        }
      }
      move(join(courseProjectsRoot(userId), slug), join(courseProjectsRoot(userId), mapping.courseId))
      move(courseProjectStateDir(userId, slug), courseProjectStateDir(userId, mapping.courseId))
      for (const [oldId, newId] of projectMap) {
        move(join(courseProjectsRoot(userId), mapping.courseId, oldId), join(courseProjectsRoot(userId), mapping.courseId, newId))
        move(join(courseProjectStateDir(userId, mapping.courseId), `${oldId}.json`), join(courseProjectStateDir(userId, mapping.courseId), `${newId}.json`))
      }
      tx((d) => {
        registerDocument(d, document)
        d.prepare('UPDATE chats SET course_slug=?,course_id=? WHERE course_slug=? AND course_id IS NULL').run(mapping.courseId, mapping.courseId, slug)
        const chats = d.prepare('SELECT id,module_slug,lesson_slug,start_lesson_id FROM chats WHERE course_id=?').all(mapping.courseId) as { id: string; module_slug: string; lesson_slug: string; start_lesson_id: string | null }[]
        for (const chat of chats) {
          const mapped = lessons.get(`${chat.module_slug}/${chat.lesson_slug}`)
          if (!mapped && !chat.start_lesson_id) (document.recoveryNotes ??= []).push(`Chat start: ${chat.id}`)
          if (mapped) d.prepare('UPDATE chats SET module_slug=?,lesson_slug=?,start_lesson_id=? WHERE id=?').run(mapped.moduleId, mapped.lessonId, mapped.lessonId, chat.id)
          const messages = d.prepare('SELECT seq,module_slug,lesson_slug FROM chat_messages WHERE chat_id=? AND lesson_id IS NULL').all(chat.id) as { seq: number; module_slug: string; lesson_slug: string }[]
          for (const message of messages) {
            const ref = lessons.get(`${message.module_slug}/${message.lesson_slug}`)
            if (!ref && message.lesson_slug) (document.recoveryNotes ??= []).push(`Message: ${chat.id}/${message.seq}`)
            if (ref) d.prepare('UPDATE chat_messages SET module_slug=?,lesson_slug=?,lesson_id=? WHERE chat_id=? AND seq=?').run(ref.moduleId, ref.lessonId, ref.lessonId, chat.id, message.seq)
          }
        }
        d.prepare('UPDATE course_project_chats SET course_slug=?,course_id=? WHERE course_slug=? AND course_id IS NULL').run(mapping.courseId, mapping.courseId, slug)
        for (const [oldId, newId] of projectMap) {
          d.prepare('UPDATE course_project_chats SET module_slug=?,module_id=? WHERE course_id=? AND module_slug=?').run(newId, newId, mapping.courseId, oldId)
          const messages = d.prepare('SELECT m.chat_id,m.seq,m.payload FROM course_project_messages m JOIN course_project_chats c ON c.id=m.chat_id WHERE c.course_id=? AND c.module_id=?').all(mapping.courseId, newId) as { chat_id: string; seq: number; payload: string }[]
          for (const message of messages) {
            const payload = JSON.parse(message.payload) as { project?: { moduleSlug?: string; moduleId?: string; fingerprint: string } }
            if (payload.project) payload.project = { moduleId: newId, fingerprint: payload.project.fingerprint }
            d.prepare('UPDATE course_project_messages SET payload=? WHERE chat_id=? AND seq=?').run(JSON.stringify(payload), message.chat_id, message.seq)
          }
        }
        for (const row of d.prepare('SELECT id FROM course_project_chats WHERE course_id=? AND module_id IS NULL').all(mapping.courseId) as { id: string }[]) (document.recoveryNotes ??= []).push(`Unlinked project chat: ${row.id}`)
      })
      if (document.recoveryNotes) document.recoveryNotes = [...new Set(document.recoveryNotes)]
      atomicJSON(join(root, 'document.json'), document)
      move(join(courses, slug), join(recovery, `${slug}.package`))
      move(progressPath, join(recovery, `${slug}.progress.original`))
      atomicJSON(journal, { ...mapping, recoveryNotes: document.recoveryNotes, complete: true })
    }
  } finally { migrating.delete(userId) }
}

export function ensureCourseStorage(): void {
  migrateLegacyCourses()
  const userId = requireUser()
  const parent = userCoursesDir(userId)
  if (!existsSync(parent)) return
  for (const name of readdirSync(parent)) if (UUID.test(name) && lstatSync(join(parent, name)).isDirectory()) {
    recoverCourseOperation(name)
    sweepStaleEdit(name, userId)
  }
}

/** Package-relative upload folders an edit session wrote: `assets/<kind>/<uuid>`. */
export const UPLOAD_PREFIX = /^assets\/(?:images|video|viz)\/[0-9a-f-]{36}$/

/**
 * An edit journal with no live session is what a crash or a forced quit left
 * behind: the editor's unsaved state is gone, so its files go too. A course
 * that was never saved is removed outright, chats and all.
 */
function sweepStaleEdit(courseId: string, userId: string): void {
  if (editSession(userId, courseId)) return
  const root = courseDirectory(courseId, userId)
  const journal = readJournal(root)
  if (!journal) return
  if (journal.new && !existsSync(join(root, 'document.json'))) {
    commitCourseOperation(null, null, courseId, [root], (d) => { d.prepare('DELETE FROM library_courses WHERE id=?').run(courseId) })
    return
  }
  let kept: string[] = []
  try { kept = readDocument(courseId).attachments.flatMap((a) => a.files) } catch { return }
  const cleanup = journal.uploads
    .filter((prefix) => UPLOAD_PREFIX.test(prefix) && !kept.some((file) => file.startsWith(`${prefix}/`)))
    .map((prefix) => join(root, 'package', prefix))
  commitCourseOperation(null, null, courseId, [...cleanup, join(root, SESSION_JOURNAL)], () => {})
}

export function validateLocalDocument(document: CourseDocument): string[] {
  if (!document.manifest) return []
  const portable = portableManifest(document.manifest)
  return validateManifest(portable)
}

export function localNodeIds(document: CourseDocument): Set<string> { return new Set(courseNodes(document.manifest).map((n) => n.id)) }
