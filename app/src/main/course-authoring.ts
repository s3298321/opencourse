import { beginCourseMutation, courseBusy } from './course-busy'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { dialog } from 'electron'
import type { Attachment, AuthoringCourse, CourseDocument, CourseDraft, CourseNode, SaveCourseResult, SavePreview } from '../core/course-document'
import { courseNodes, currentFormat, deletedNodes, emptyManifest, materializeDraft, portableManifest, reconcileProgress, reidentifyManifest, validateIdentities } from '../core/course-document'
import { assertAuthoringWritable, authoringEvents, revokeAuthoringTurn } from './authoring-state'
import type { CourseManifest } from '../core/types'
import { referencedAssets } from '../core/manifest'
import { classifyEntry, LIMITS } from '../core/import'
import { validateManifest } from '../core/schema'
import { getToolchain, resolveRuntime } from '../core/toolchains'
import type { ExerciseBlock } from '../core/types'
import { resolveInside } from '../core/safepath'
import { atomicJSON, commitCourseOperation, courseDirectory, ensureCourseStorage, packageDirectory, readDocument, readLegacyDraft, UPLOAD_PREFIX } from './course-store'
import { canonicalJSON, editSession, isSessionDirty, putEditSession, removeEditSession, SESSION_JOURNAL, sessionsHeldBy, userEditSessions, type EditSession } from './edit-sessions'
import { registerDocument } from './course-registry'
import { db, tx } from './db'
import { reloadCourses } from './courses'
import { cancelCourseChats } from './chat'
import { cancelCourseProjectChats } from './projectchat'
import { disposePtysInDirectory } from './pty'
import { stopCourseWork } from './toolchain'
import { courseProjectDir, courseProjectStateDir, userWorkspaceRoot } from './paths'
import { currentUserId, requireUser } from './users'
import { readProgress } from './progress'
import { extractArchive } from './unzip'

const executeFile = promisify(execFile)
export const isCourseCommitting = courseBusy

/**
 * Starts a course that exists only in the editor until its first save. The
 * placeholder directory holds uploads and the edit journal; the library row is
 * there because authoring chats reference it. Neither shows in the library,
 * which lists directories that have a document.
 */
export function createCourse(): AuthoringCourse {
  const userId = requireUser()
  const courseId = randomUUID()
  const root = courseDirectory(courseId)
  mkdirSync(join(root, 'package'), { recursive: true })
  atomicJSON(join(root, SESSION_JOURNAL), { new: true, uploads: [] })
  const document: CourseDocument = { version: 1, courseId, revision: 0, manifest: null, attachments: [] }
  tx((d) => registerDocument(d, document))
  const manifest = emptyManifest()
  putEditSession({ userId, courseId, document, baseRevision: 0, draftVersion: 0, manifest, baseline: canonicalJSON(manifest), isNew: true, legacyDraft: false, uploads: [], chatIds: new Set(), holders: new Set() })
  return getAuthoringCourse(courseId)
}

function draftOf(session: EditSession): CourseDraft {
  return { courseId: session.courseId, baseRevision: session.baseRevision, draftVersion: session.draftVersion, manifest: structuredClone(session.manifest), dirty: isSessionDirty(session) }
}

/**
 * The course as the editor sees it: the saved document, plus the uploads this
 * session made (so pickers and the assistant can use them), and the working copy.
 * Without a session it is what opening the editor would start from.
 */
export function getAuthoringCourse(courseId: string): AuthoringCourse {
  ensureCourseStorage()
  const session = editSession(requireUser(), courseId)
  const document = readDocument(courseId)
  if (document.error) throw new Error(document.error)
  if (session) return { document: { ...document, attachments: [...document.attachments, ...structuredClone(session.uploads)] }, draft: draftOf(session) }
  const legacy = readLegacyDraft(document)
  if (legacy) return { document, draft: { ...legacy, dirty: canonicalJSON(legacy.manifest) !== canonicalJSON(document.manifest ?? emptyManifest()) } }
  if (!document.manifest) throw new Error('This course has no recoverable draft.')
  return { document, draft: { courseId, baseRevision: document.revision, draftVersion: 0, manifest: structuredClone(document.manifest), dirty: false } }
}

function ensureSession(courseId: string): EditSession {
  const userId = requireUser()
  const existing = editSession(userId, courseId)
  if (existing) return existing
  const { document, draft } = getAuthoringCourse(courseId)
  return putEditSession({
    userId, courseId, document, baseRevision: draft.baseRevision, draftVersion: draft.draftVersion,
    manifest: structuredClone(draft.manifest), baseline: canonicalJSON(document.manifest ?? emptyManifest()),
    isNew: false, legacyDraft: readLegacyDraft(document) !== null, uploads: [], chatIds: new Set(), holders: new Set()
  })
}

/** An editor window opening a course: it holds the session until it leaves or goes away. */
export function openEditSession(courseId: string, holder: number): AuthoringCourse {
  ensureSession(courseId).holders.add(holder)
  return getAuthoringCourse(courseId)
}

/** A window that closed, crashed or reloaded takes its unsaved edits with it. */
export function releaseEditSessions(holder: number): void {
  const userId = currentUserId()
  for (const session of sessionsHeldBy(holder)) {
    session.holders.delete(holder)
    if (session.holders.size || session.userId !== userId) continue
    try { discardCourseDraft(session.courseId, { force: true }) } catch { removeEditSession(session.userId, session.courseId) }
  }
}

/** Switching users: the sessions are theirs, and the journal sweep tidies their files. */
export function forgetEditSessions(): void {
  const userId = currentUserId()
  if (!userId) return
  for (const session of userEditSessions(userId)) {
    revokeAuthoringTurn(session.courseId)
    removeEditSession(userId, session.courseId)
  }
}

export function isEditSessionDirty(courseId: string): boolean {
  const session = editSession(requireUser(), courseId)
  return session ? isSessionDirty(session) : false
}

export function dirtyHolders(): Set<number> {
  const userId = currentUserId()
  const held = new Set<number>()
  if (userId) for (const session of userEditSessions(userId)) if (isSessionDirty(session)) for (const holder of session.holders) held.add(holder)
  return held
}

export function noteAuthoringChat(courseId: string, chatId: string): void {
  editSession(requireUser(), courseId)?.chatIds.add(chatId)
}

function writeJournal(session: EditSession): void {
  const prefixes = session.uploads.map((a) => a.files[0]?.split('/').slice(0, 3).join('/')).filter((p): p is string => Boolean(p))
  atomicJSON(join(courseDirectory(session.courseId), SESSION_JOURNAL), { new: session.isNew, uploads: [...new Set(prefixes)] })
}

/** Writes only the edit session. Nothing reaches the course until saveCourse. */
export function saveDraft(courseId: string, manifest: CourseManifest, baseRevision: number, expectedDraftVersion: number, authoringToken?: symbol): CourseDraft | { status: 'conflict' } {
  assertAuthoringWritable(courseId, authoringToken)
  if (isCourseCommitting(courseId)) return { status: 'conflict' }
  const { document, draft: current } = getAuthoringCourse(courseId)
  if (document.revision !== baseRevision || current.draftVersion !== expectedDraftVersion || current.baseRevision !== baseRevision) return { status: 'conflict' }
  if (!manifest || !Array.isArray(manifest.modules) || Buffer.byteLength(JSON.stringify(manifest)) > 10 * 1024 * 1024) throw new Error('Invalid or oversized course draft.')
  for (const node of courseNodes(manifest)) {
    const owner = db().prepare('SELECT course_id FROM course_elements WHERE id=?').get(node.id) as { course_id: string } | undefined
    if (owner && owner.course_id !== courseId) throw new Error('An element belongs to another course.')
  }
  const session = ensureSession(courseId)
  session.manifest = structuredClone(manifest)
  session.draftVersion = current.draftVersion + 1
  return draftOf(session)
}

export function previewCourseSave(courseId: string): SavePreview {
  const { document, draft } = getAuthoringCourse(courseId)
  const projected = portableManifest(draft.manifest)
  Object.assign(projected, currentFormat(projected))
  const errors = [...validateManifest(projected), ...validateIdentities(draft.manifest, document.manifest, true)]
  for (const asset of referencedAssets(draft.manifest)) if (!resolveInside(packageDirectory(courseId), asset)) errors.push(`Missing attachment: ${asset}`)
  for (const node of courseNodes(draft.manifest)) {
    const owner = db().prepare('SELECT course_id FROM course_elements WHERE id=?').get(node.id) as { course_id: string } | undefined
    if (owner && owner.course_id !== courseId) errors.push(`${node.label}: local identity belongs to another course`)
  }
  const deleted = deletedNodes(document.manifest, draft.manifest)
  return { errors, deleted, ...deletionImpact(courseId, deleted) }
}

/** Stops everything that is reading or writing a course's learner data before it changes. */
export async function stopCourseActivity(owner: string, courseId: string): Promise<void> {
  cancelCourseChats(courseId)
  cancelCourseProjectChats(courseId)
  disposePtysInDirectory(join(userWorkspaceRoot(owner), courseId))
  await stopCourseWork(join(userWorkspaceRoot(owner), courseId))
}

/**
 * The learner files a change from `before` to `after` leaves behind: the
 * workspaces of deleted exercises and projects, and generated support files
 * a surviving exercise no longer has. The learner's own file is never in it.
 */
export function changeCleanup(owner: string, courseId: string, before: CourseManifest | null, after: CourseManifest, deleted: CourseNode[]): string[] {
  const cleanup: string[] = []
  for (const node of deleted) {
    if (node.kind === 'exercise') cleanup.push(join(userWorkspaceRoot(owner), courseId, 'exercises', node.id))
    if (node.kind === 'project') cleanup.push(courseProjectDir(owner, courseId, node.id), join(courseProjectStateDir(owner, courseId), `${node.id}.json`))
  }
  if (!before) return cleanup
  const exercises = (m: CourseManifest) => m.modules.flatMap((mod) => mod.type === 'project' ? [] : mod.lessons.flatMap((l) => l.blocks.filter((b): b is ExerciseBlock => b.type === 'exercise')))
  const support = (m: CourseManifest, block: ExerciseBlock): string[] => {
    const layout = getToolchain(resolveRuntime(m, block).language).layout
    return [...(block.extra_files ?? []).map((f) => f.path), ...(block.tests ? [layout.testFile] : []), ...(block.solution ? [layout.solutionFile] : [])]
  }
  const nextExercises = new Map(exercises(after).map((b) => [b.nodeId, b]))
  for (const old of exercises(before)) {
    const surviving = nextExercises.get(old.nodeId)
    if (!surviving) continue
    const nextFiles = new Set(support(after, surviving))
    const learnerFiles = new Set([getToolchain(resolveRuntime(before, old).language).layout.learnerFile, getToolchain(resolveRuntime(after, surviving).language).layout.learnerFile])
    for (const file of support(before, old)) {
      if (!nextFiles.has(file) && !learnerFiles.has(file) && !file.split(/[\\/]/).includes('..') && !file.startsWith('/')) cleanup.push(join(userWorkspaceRoot(owner), courseId, 'exercises', old.nodeId!, file))
    }
  }
  return cleanup
}

/**
 * The one way a course's content changes once a learner may have progress in
 * it - an author's save or a server update. Progress follows element IDs
 * (reconcileProgress): whatever survives keeps it, whatever was removed takes
 * it along, and chats left with nothing but context go too. Journaled, so an
 * interrupted change finishes or never happened.
 */
export function commitCourseChange(courseId: string, next: CourseDocument, before: CourseManifest | null, deleted: CourseNode[], cleanup: string[], options: { nodeRefMap?: Record<string, string>; packageSwap?: boolean } = {}): void {
  const progress = reconcileProgress(readProgress(courseId), before, next.manifest!)
  commitCourseOperation(next, progress, courseId, cleanup, (d) => {
    // Clear titles before FK cascades erase the evidence of which chats changed.
    const affectedChats = new Set<string>()
    for (const node of deleted.filter((n) => n.kind === 'lesson')) {
      for (const row of d.prepare('SELECT DISTINCT chat_id FROM chat_messages WHERE lesson_id=?').all(node.id) as { chat_id: string }[]) affectedChats.add(row.chat_id)
      d.prepare('UPDATE chats SET generated_title=NULL WHERE course_id=? AND id IN (SELECT chat_id FROM chat_messages WHERE lesson_id=?)').run(courseId, node.id)
    }
    registerDocument(d, next)
    for (const [ref, id] of Object.entries(options.nodeRefMap ?? {})) {
      d.prepare("UPDATE authoring_messages SET payload=json_set(payload, '$.authoring.target.ref', ?) WHERE chat_id IN (SELECT id FROM authoring_chats WHERE course_id=?) AND json_extract(payload, '$.authoring.target.ref')=?").run(id, courseId, ref)
    }
    for (const id of affectedChats) d.prepare("DELETE FROM chats WHERE id=? AND course_id=? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE chat_id=chats.id AND role<>'context')").run(id, courseId)
  }, { packageSwap: options.packageSwap })
}

/** How much learner data deleting these elements takes with it - for the confirmation. */
export function deletionImpact(courseId: string, deleted: CourseNode[]): { messages: number; workspaces: number } {
  let messages = 0
  for (const node of deleted.filter((n) => n.kind === 'lesson')) messages += Number((db().prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE lesson_id=?').get(node.id) as { n: number }).n)
  for (const node of deleted.filter((n) => n.kind === 'project')) messages += Number((db().prepare('SELECT COUNT(*) AS n FROM course_project_messages m JOIN course_project_chats c ON c.id=m.chat_id WHERE c.course_id=? AND c.module_id=?').get(courseId, node.id) as { n: number }).n)
  return { messages, workspaces: deleted.filter((n) => n.kind === 'exercise' || n.kind === 'project').length }
}

export async function saveCourse(courseId: string, revision: number, draftVersion: number, confirmDeletion = false): Promise<SaveCourseResult> {
  assertAuthoringWritable(courseId)
  const owner = requireUser()
  if (courseBusy(courseId)) return { status: 'conflict' }
  const release = beginCourseMutation(courseId)
  try {
    const { document, draft } = getAuthoringCourse(courseId)
    if (document.revision !== revision || draft.baseRevision !== revision || draft.draftVersion !== draftVersion) return { status: 'conflict' }
    const preview = previewCourseSave(courseId)
    if (preview.errors.length) return { status: 'invalid', errors: preview.errors }
    // A learner never changes a course they added from a server; their edits become a course of their own.
    if (document.origin?.role === 'learner') return saveAsLocalCopy(owner, courseId, document, draft.manifest)
    if (preview.deleted.length && !confirmDeletion) return { status: 'confirmation-required', preview }
    await stopCourseActivity(owner, courseId)
    if (requireUser() !== owner) throw new Error('The active user changed during save.')
    const latest = getAuthoringCourse(courseId)
    if (latest.document.revision !== revision || latest.draft.draftVersion !== draftVersion) return { status: 'conflict' }
    const materialized = materializeDraft(draft.manifest, randomUUID)
    const next: CourseDocument = { ...document, revision: revision + 1, nodeRefMap: materialized.nodeRefMap, manifest: currentFormat(materialized.manifest) }
    const cleanup = [join(courseDirectory(courseId), 'draft.json'), join(courseDirectory(courseId), SESSION_JOURNAL), ...changeCleanup(owner, courseId, document.manifest, draft.manifest, preview.deleted)]
    const referenced = new Set(referencedAssets(draft.manifest))
    const keep: Attachment[] = []
    for (const attachment of document.attachments) {
      if (!attachment.managed || attachment.files.some((file) => referenced.has(file))) keep.push(attachment)
      else for (const file of attachment.files) cleanup.push(join(packageDirectory(courseId), file))
    }
    next.attachments = keep
    commitCourseChange(courseId, next, document.manifest, preview.deleted, cleanup, { nodeRefMap: materialized.nodeRefMap })
    // The saved course is the session's new starting point; the editors holding
    // it stay open on it.
    const session = editSession(owner, courseId)
    if (session) Object.assign(session, { document: next, baseRevision: next.revision, draftVersion: 0, manifest: structuredClone(next.manifest!), baseline: canonicalJSON(next.manifest), isNew: false, legacyDraft: false, uploads: [] })
    reloadCourses()
    authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId), materialized.nodeRefMap)
    return { status: 'ok', revision: next.revision, nodeRefMap: materialized.nodeRefMap }
  } finally { reloadCourses(); release() }
}

/**
 * Saving edits to a course a learner added from a server: the edits become a
 * new local course - fresh IDs, no origin, fresh progress - and the downloaded
 * course is left exactly as it was, still receiving updates. Assistant chats
 * from this editing session move with the edits.
 */
function saveAsLocalCopy(owner: string, courseId: string, document: CourseDocument, working: CourseManifest): SaveCourseResult {
  const { manifest, map } = reidentifyManifest(working, randomUUID)
  const copyId = randomUUID()
  const root = courseDirectory(copyId)
  const referenced = new Set(referencedAssets(manifest))
  const keep = document.attachments.filter((a) => !a.managed || a.files.some((file) => referenced.has(file)))
  const next: CourseDocument = { version: 1, courseId: copyId, revision: 1, manifest: currentFormat(manifest), attachments: keep }
  try {
    mkdirSync(root, { recursive: true })
    cpSync(packageDirectory(courseId), join(root, 'package'), { recursive: true })
    for (const attachment of document.attachments) if (!keep.includes(attachment)) for (const file of attachment.files) rmSync(join(root, 'package', file), { force: true })
    atomicJSON(join(root, 'document.json'), next)
    tx((d) => {
      registerDocument(d, next)
      for (const chatId of editSession(owner, courseId)?.chatIds ?? []) d.prepare('UPDATE authoring_chats SET course_id=? WHERE id=? AND course_id=?').run(copyId, chatId, courseId)
      for (const [old, fresh] of Object.entries(map)) {
        d.prepare("UPDATE authoring_messages SET payload=json_set(payload, '$.authoring.target.ref', ?) WHERE chat_id IN (SELECT id FROM authoring_chats WHERE course_id=?) AND json_extract(payload, '$.authoring.target.ref')=?").run(fresh, copyId, old)
      }
    })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  revokeAuthoringTurn(courseId)
  dropEditSession(courseId)
  reloadCourses()
  return { status: 'ok', revision: 1, nodeRefMap: map, copiedTo: copyId }
}

/**
 * Drops the edit session: its uploads are deleted and the course is left as it
 * was saved. A course that was never saved goes entirely. `force` is the
 * editor leaving - it stops the assistant first instead of refusing.
 */
export function discardCourseDraft(courseId: string, options: { force?: boolean } = {}): { removed: boolean } {
  if (options.force) revokeAuthoringTurn(courseId)
  assertAuthoringWritable(courseId)
  if (isCourseCommitting(courseId)) throw new Error('The course is being saved.')
  return dropEditSession(courseId)
}

/** Discard's work, for callers that already hold the course (a save that became a copy). */
function dropEditSession(courseId: string): { removed: boolean } {
  const userId = requireUser()
  const session = editSession(userId, courseId)
  const root = courseDirectory(courseId)
  try {
    const document = readDocument(courseId)
    if (session?.isNew || !document.manifest) {
      commitCourseOperation(null, null, courseId, [root], (d) => { d.prepare('DELETE FROM library_courses WHERE id=?').run(courseId) })
      return { removed: true }
    }
    const committed = new Set(document.attachments.flatMap((a) => a.files))
    const cleanup = [join(root, 'draft.json'), join(root, SESSION_JOURNAL)]
    for (const upload of session?.uploads ?? []) {
      const prefix = upload.files[0]?.split('/').slice(0, 3).join('/')
      if (prefix && UPLOAD_PREFIX.test(prefix) && !upload.files.some((f) => committed.has(f))) cleanup.push(join(packageDirectory(courseId), prefix))
    }
    commitCourseOperation(null, null, courseId, cleanup, () => {})
    return { removed: false }
  } finally {
    removeEditSession(userId, courseId)
    reloadCourses()
  }
}

function enumerate(root: string, parent = root): string[] {
  const files: string[] = []
  for (const name of readdirSync(parent)) {
    const path = join(parent, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Attachment bundles cannot contain symlinks.')
    if (stat.isDirectory()) files.push(...enumerate(root, path))
    else {
      const rel = relative(root, path).split('\\').join('/')
      const verdict = classifyEntry(rel, { isSymlink: false, size: stat.size })
      if (verdict.kind === 'reject') throw new Error(verdict.reason)
      if (verdict.kind === 'file') files.push(rel)
    }
  }
  if (files.length > LIMITS.members) throw new Error('Too many attachment files.')
  return files
}

export type AttachmentKind = 'image' | 'video' | 'visualization'
export interface AttachmentUpload { attachment: Attachment; htmlEntries: string[] }

/** Internal service seam; normal renderer access selects files through native dialogs. */
export async function uploadCourseAttachmentPath(courseId: string, source: string, kind: AttachmentKind, authoringToken?: symbol, preferredEntry?: string): Promise<AttachmentUpload> {
  assertAuthoringWritable(courseId, authoringToken)
  const owner = requireUser()
  if (isCourseCommitting(courseId)) throw new Error('The course is being saved.')
  readDocument(courseId)
  const staging = mkdtempSync(join(tmpdir(), 'opencourse-attachment-'))
  try {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error('Attachments cannot be symlinks.')
    if (stat.isDirectory()) {
      if (kind !== 'visualization') throw new Error('Only visualization bundles may be directories.')
      enumerate(source)
      cpSync(source, staging, { recursive: true })
    } else if (extname(source).toLowerCase() === '.zip' && kind === 'visualization') {
      if (stat.size > LIMITS.archiveBytes) throw new Error('The attachment archive is too large.')
      const result = await extractArchive(source, staging)
      if (result.error) throw new Error(result.error)
    } else {
      const name = source.split(/[\\/]/).pop()!
      const verdict = classifyEntry(name, { isSymlink: false, size: stat.size })
      if (verdict.kind !== 'file') throw new Error(verdict.kind === 'reject' ? verdict.reason : 'Unsupported attachment.')
      cpSync(source, join(staging, name))
    }
    const files = enumerate(staging)
    if (!files.length) throw new Error('The attachment is empty.')
    const html = files.filter((f) => /\.html?$/i.test(f))
    if (kind === 'visualization' && !html.length) throw new Error('Choose a bundle containing an HTML entry point.')
    if (kind === 'image' && (files.length !== 1 || !/\.(svg|png|jpe?g|gif|webp)$/i.test(files[0]))) throw new Error('Choose a supported image.')
    if (kind === 'video' && (files.length !== 1 || !/\.(mp4|webm)$/i.test(files[0]))) throw new Error('Choose an MP4 or WebM video.')
    if (requireUser() !== owner || isCourseCommitting(courseId)) throw new Error('The active course changed during upload.')
    assertAuthoringWritable(courseId, authoringToken)
    // The files go to their immutable package path so the preview can serve
    // them, but the attachment is the session's until Save records it. The
    // journal names it first, so a crash cannot leave an unlisted folder.
    const session = ensureSession(courseId)
    const id = randomUUID()
    const prefix = `assets/${kind === 'visualization' ? 'viz' : kind === 'image' ? 'images' : 'video'}/${id}`
    const entry = kind === 'visualization' ? (preferredEntry && html.includes(preferredEntry) ? preferredEntry : html.find((f) => /(^|\/)index\.html?$/i.test(f)) ?? html[0]) : files[0]
    const attachment: Attachment = { id, entry: `${prefix}/${entry}`, files: files.map((f) => `${prefix}/${f}`), managed: true }
    session.uploads.push(attachment)
    writeJournal(session)
    const destination = join(packageDirectory(courseId), prefix)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(staging, destination, { recursive: true })
    return { attachment, htmlEntries: html.map((f) => `${prefix}/${f}`) }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

export async function uploadCourseAttachment(courseId: string, kind: AttachmentKind, bundleFolder = false): Promise<AttachmentUpload | null> {
  assertAuthoringWritable(courseId)
  const owner = requireUser()
  readDocument(courseId)
  const picked = await dialog.showOpenDialog({ title: `Upload ${kind}`, properties: bundleFolder ? ['openDirectory'] : ['openFile'], filters: bundleFolder ? [] : [{ name: kind, extensions: kind === 'visualization' ? ['html', 'htm', 'zip'] : kind === 'image' ? ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] : ['mp4', 'webm'] }] })
  if (picked.canceled || !picked.filePaths[0]) return null
  if (requireUser() !== owner) throw new Error('The active user changed during upload.')
  return uploadCourseAttachmentPath(courseId, picked.filePaths[0], kind)
}

/**
 * Packs the last saved version as an archive at `destination`. `project` makes
 * its course.json: the portable manifest for Export ZIP, the published one
 * (every identity as a uid) for a server. Uploads not yet saved never go.
 */
export async function packCourse(courseId: string, destination: string, project: (manifest: CourseManifest) => CourseManifest): Promise<void> {
  const { document } = getAuthoringCourse(courseId)
  if (!document.manifest) throw new Error('Save a valid course before exporting it.')
  const packed = project(document.manifest)
  const errors = validateManifest(packed)
  if (errors.length) throw new Error(errors.join('; '))
  const staging = mkdtempSync(join(tmpdir(), 'opencourse-export-'))
  const archive = join(staging, 'course.zip')
  try {
    const packageRoot = join(staging, 'package')
    mkdirSync(packageRoot)
    const committed = new Set(referencedAssets(document.manifest))
    const uncommitted = new Set(document.attachments.filter((a) => a.managed && !a.files.some((f) => committed.has(f))).flatMap((a) => a.files))
    for (const file of enumerate(packageDirectory(courseId))) {
      if (file === 'course.json' || uncommitted.has(file)) continue
      const from = resolveInside(packageDirectory(courseId), file)
      if (!from) throw new Error('Invalid package asset.')
      mkdirSync(dirname(join(packageRoot, file)), { recursive: true })
      cpSync(from, join(packageRoot, file))
    }
    atomicJSON(join(packageRoot, 'course.json'), packed)
    for (const file of referencedAssets(packed)) if (!resolveInside(packageRoot, file)) throw new Error(`Missing attachment: ${file}`)
    await executeFile('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', packageRoot, archive])
    if (statSync(archive).size > LIMITS.archiveBytes) throw new Error('The exported course exceeds the import size limit.')
    // Native save dialog chooses the only external write target. Publish after successful packing.
    cpSync(archive, destination)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

export async function exportCourseZipPath(courseId: string, destination: string): Promise<void> {
  await packCourse(courseId, destination, (manifest) => currentFormat(portableManifest(manifest)))
}

export async function exportCourseZip(courseId: string): Promise<{ saved: string | null }> {
  const owner = requireUser()
  const document = readDocument(courseId)
  if (!document.manifest) throw new Error('Save the course before exporting it.')
  const picked = await dialog.showSaveDialog({ title: 'Export course', defaultPath: `${document.manifest.slug}.zip`, filters: [{ name: 'Course archive', extensions: ['zip'] }] })
  if (picked.canceled || !picked.filePath) return { saved: null }
  if (requireUser() !== owner) throw new Error('The active user changed during export.')
  await exportCourseZipPath(courseId, picked.filePath)
  return { saved: picked.filePath }
}
