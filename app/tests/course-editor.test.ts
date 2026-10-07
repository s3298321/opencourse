import { projectContextText } from '../src/core/projects/context'
// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyElement, deleteElement, editElement, moveElement, newBlock } from '../src/core/course-editor'
import { courseNodes, identifyManifest, portableManifest } from '../src/core/course-document'
import type { CourseDocument } from '../src/core/course-document'
import type { Block, CourseManifest, QuizBlock } from '../src/core/types'
import { emptyProgress } from '../src/core/progress'
import { installCourseFixture } from './helpers/course'
import { projectCourse } from './helpers/project'
import { makeZip } from './helpers/zip'

const root = mkdtempSync(join(tmpdir(), 'opencourse-editor-'))
let dataDir = join(root, 'data')
const runtime = vi.hoisted(() => ({ stop: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ app: { getPath: () => dataDir, on: () => {} }, dialog: {} }))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: runtime.stop }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: vi.fn() }))
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db, tx } = await import('../src/main/db')
const { getCourse, listCourses, reloadCourses } = await import('../src/main/courses')
const { importCourseZip, removeCourse } = await import('../src/main/import')
const { createCourse, getAuthoringCourse, saveDraft, saveCourse, previewCourseSave, discardCourseDraft, uploadCourseAttachmentPath, exportCourseZipPath } = await import('../src/main/course-authoring')
const { atomicJSON, courseDirectory, packageDirectory, readDocument, ensureCourseStorage } = await import('../src/main/course-store')
const { registerDocument } = await import('../src/main/course-registry')
const { userCoursesDir, userProgressDir, userWorkspaceRoot, courseProjectDir, courseProjectStateDir } = await import('../src/main/paths')
const { requireCourseProject, openCourseProject } = await import('../src/main/courseprojects')
const { readProgress, writeProgress } = await import('../src/main/progress')
const { insertChat, appendMessage, selectChat, selectMessages } = await import('../src/main/chatdb')
const { insertProjectChat, appendProjectMessage, selectProjectChat } = await import('../src/main/projectchatdb')
const { extractArchive } = await import('../src/main/unzip')
const AT = '2026-10-05T10:00:00.000Z'
let userId = '', serial = 0
beforeEach(() => {
  closeDb(); dataDir = join(root, `data-${++serial}`); userId = createUser('Author').id
  runtime.stop.mockReset().mockResolvedValue(undefined); reloadCourses()
})
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })

function manifest(): CourseManifest {
  const course = projectCourse()
  course.modules[0].lessons![0].blocks.push(
    { type: 'quiz', slug: 'quiz', id: 'quiz', kind: 'single', question: 'Which?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] },
    { type: 'exercise', slug: 'exercise', id: 'exercise', title: 'Exercise', prompt: 'Write it', starter_code: '# start', solution: '# solution', tests: 'assert True', verification_instructions: 'Pass tests' }
  )
  course.modules[0].lessons!.push({ slug: 'other', title: 'Other lesson', blocks: [{ type: 'markdown', slug: 'other', content: 'Other' }] })
  return course
}
function write(path: string, text = 'learner work'): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
function draft(courseId: string, change: (manifest: CourseManifest) => CourseManifest) {
  const authoring = getAuthoringCourse(courseId)
  const result = saveDraft(courseId, change(structuredClone(authoring.draft.manifest)), authoring.document.revision, authoring.draft.draftVersion)
  if ('status' in result) throw new Error('Unexpected fixture conflict')
  return result
}

describe('local course identities and drafts', () => {
  it('imports identical ZIPs independently and excludes local fields from the portable projection', async () => {
    const zip = makeZip(join(root, `import-${serial}.zip`), [{ name: 'course.json', content: JSON.stringify(manifest()) }])
    const a = await importCourseZip(zip), b = await importCourseZip(zip)
    expect(a.status).toBe('ok'); expect(b.status).toBe('ok')
    if (a.status !== 'ok' || b.status !== 'ok') return
    expect(a.courseId).not.toBe(b.courseId)
    const first = readDocument(a.courseId), second = readDocument(b.courseId)
    const firstIds = new Set(courseNodes(first.manifest).map((n) => n.id))
    expect(courseNodes(second.manifest).some((n) => firstIds.has(n.id))).toBe(false)
    // An archive from before 1.5 starts at the default version; nothing else is added.
    expect(portableManifest(first.manifest!)).toEqual({ ...manifest(), version: '0.1.0' })
    expect(listCourses().map((c) => c.slug)).toEqual(['projects-demo', 'projects-demo'])
    writeProgress({ ...emptyProgress(a.courseId), completedLessons: [first.manifest!.modules[0].lessons![0].nodeId!] })
    expect(readProgress(b.courseId).completedLessons).toEqual([])
  })
  it('keeps a new course out of the library until its first valid save, and keeps its UUID', async () => {
    const created = createCourse(), id = created.document.courseId
    expect(listCourses().find((c) => c.courseId === id)).toBeUndefined()
    expect(existsSync(join(courseDirectory(id), 'document.json'))).toBe(false)
    expect(getCourse(id)).toBeUndefined()
    expect(await saveCourse(id, 0, 0)).toMatchObject({ status: 'invalid' })
    const saved = draft(id, () => identifyManifest(manifest(), randomUUID))
    expect(await saveCourse(id, 0, saved.draftVersion)).toMatchObject({ status: 'ok', revision: 1 })
    expect(getCourse(id)?.courseId).toBe(id)
    expect(listCourses().find((c) => c.courseId === id)?.draft).toBeUndefined()
  })
  it('persists invalid drafts without applying them and detects stale window writes', async () => {
    const course = installCourseFixture(manifest()), before = readDocument(course.courseId)
    const saved = draft(course.courseId, (m) => ({ ...m, title: '' }))
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('')
    expect(await saveCourse(course.courseId, before.revision, saved.draftVersion)).toMatchObject({ status: 'invalid' })
    expect(readDocument(course.courseId)).toEqual(before)
    expect(saveDraft(course.courseId, before.manifest!, before.revision, 0)).toEqual({ status: 'conflict' })
    expect(await saveCourse(course.courseId, before.revision - 1, saved.draftVersion)).toEqual({ status: 'conflict' })
  })
  it('rejects IDs from another course and duplicate or type-changed IDs', () => {
    const a = installCourseFixture(manifest()), b = installCourseFixture(manifest())
    expect(() => draft(a.courseId, () => readDocument(b.courseId).manifest!)).toThrow('another course')
    draft(a.courseId, (m) => { m.modules[0].lessons![0].blocks.push(m.modules[0].lessons![0].blocks[0]); return m })
    expect(previewCourseSave(a.courseId).errors.join(';')).toContain('duplicate local identity')
  })
  it('creates and reopens every block type with support files and complete authoring content', async () => {
    const created = createCourse(), id = created.document.courseId
    const png = join(root, `all-image-${serial}.png`), video = join(root, `all-video-${serial}.mp4`), html = join(root, `all-viz-${serial}.html`)
    write(png, 'image'); write(video, 'video'); write(html, '<p>Visualization</p>')
    const image = await uploadCourseAttachmentPath(id, png, 'image'), movie = await uploadCourseAttachmentPath(id, video, 'video'), viz = await uploadCourseAttachmentPath(id, html, 'visualization')
    const content = identifyManifest(manifest(), randomUUID)
    content.cover_image = image.attachment.entry
    content.modules[0].lessons![0].blocks.push(
      { type: 'image', slug: 'picture', nodeId: randomUUID(), src: image.attachment.entry, alt: 'Picture', caption: 'Caption' },
      { type: 'video', slug: 'video', nodeId: randomUUID(), src: movie.attachment.entry, poster: image.attachment.entry, caption: 'Video' },
      { type: 'visualization', slug: 'interactive', nodeId: randomUUID(), src: viz.attachment.entry, title: 'Interactive', height: 400 }
    )
    const exercise = content.modules[0].lessons![0].blocks[2] as import('../src/core/types').ExerciseBlock
    exercise.extra_files = [{ nodeId: randomUUID(), path: 'support.py', content: 'VALUE = 1' }]
    const saved = saveDraft(id, content, 0, 0)
    if ('status' in saved) throw new Error('Conflict')
    expect(await saveCourse(id, 0, saved.draftVersion)).toMatchObject({ status: 'ok' })
    const reopened = getAuthoringCourse(id)
    expect(reopened.document.manifest!.modules[0].lessons![0].blocks.map((b) => b.type)).toEqual(['markdown', 'quiz', 'exercise', 'image', 'video', 'visualization'])
    expect(portableManifest(reopened.document.manifest!)).toEqual({ ...portableManifest(content), schema_version: '1.5', version: '0.1.0' })
    expect(getCourse(id)?.modules[0].lessons![0].blocks[2]).toMatchObject({ id: exercise.nodeId, nodeId: exercise.nodeId })
    const edited = draft(id, (m) => ({ ...m, author: 'Updated author' }))
    expect(await saveCourse(id, 1, edited.draftVersion)).toMatchObject({ status: 'ok', revision: 2 })
    expect(courseNodes(readDocument(id).manifest).map((n) => n.id)).toEqual(courseNodes(content).map((n) => n.id))
  })
  it('duplicates complete subtrees with new IDs and retains IDs when moving or renaming', () => {
    const course = installCourseFixture(manifest()), source = readDocument(course.courseId).manifest!
    const original = source.modules[0].lessons![0]
    const copy = copyElement(source, original.nodeId!, randomUUID)
    const ids = new Set(courseNodes(source).map((n) => n.id))
    expect(courseNodes(copy.manifest).filter((n) => !ids.has(n.id))).toHaveLength(6)
    const moved = moveElement(editElement(source, original.nodeId!, { slug: 'renamed', title: 'Renamed' }), original.nodeId!, source.modules[2].nodeId!)
    expect(moved.modules[2].lessons!.at(-1)?.nodeId).toBe(original.nodeId)
    expect(portableManifest(moved).modules[2].lessons!.at(-1)?.slug).toBe('renamed')
  })
  it('rejects imports and saves missing block slugs without adding names or changing stored data', async () => {
    const installed = installCourseFixture(manifest()), id = installed.courseId, legacy = readDocument(id)
    for (const module of legacy.manifest!.modules) if (module.type !== 'project') for (const lesson of module.lessons) for (const block of lesson.blocks) Reflect.deleteProperty(block, 'slug')
    const zip = makeZip(join(root, `missing-slugs-${serial}.zip`), [{ name: 'course.json', content: JSON.stringify(portableManifest(legacy.manifest!)) }])
    expect(await importCourseZip(zip)).toMatchObject({ status: 'invalid', message: expect.stringContaining('/slug:') })
    atomicJSON(join(courseDirectory(id), 'document.json'), legacy)
    const original = readFileSync(join(courseDirectory(id), 'document.json'), 'utf8')
    const recovered = structuredClone(legacy.manifest!), lesson = recovered.modules[0].lessons![0]
    if (lesson.blocks[0].type === 'markdown') lesson.blocks[0].content = '# Changed in the recovered draft'
    atomicJSON(join(courseDirectory(id), 'draft.json'), { courseId: id, baseRevision: legacy.revision, draftVersion: 7, manifest: recovered })
    writeProgress({ ...emptyProgress(id), completedLessons: [lesson.nodeId!] })
    const opened = getAuthoringCourse(id)
    expect(opened.draft.manifest.modules[0].lessons![0].blocks[0].slug).toBeUndefined()
    expect(opened.document.manifest!.modules[0].lessons![0].blocks[0].slug).toBeUndefined()
    expect(readFileSync(join(courseDirectory(id), 'document.json'), 'utf8')).toBe(original)
    expect(await saveCourse(id, legacy.revision, 7)).toMatchObject({ status: 'invalid' })
    expect(readFileSync(join(courseDirectory(id), 'document.json'), 'utf8')).toBe(original)
    expect(courseNodes(readDocument(id).manifest).map((node) => node.id)).toEqual(courseNodes(legacy.manifest).map((node) => node.id))
    expect(readProgress(id).completedLessons).toEqual([lesson.nodeId])
  })
  it('keeps invalid block-slug drafts recoverable and rejects duplicate names without publishing', async () => {
    const installed = installCourseFixture(manifest()), id = installed.courseId, before = readDocument(id)
    const invalid = draft(id, (m) => { m.modules[0].lessons![0].blocks[0].slug = ''; return m })
    expect(await saveCourse(id, before.revision, invalid.draftVersion)).toMatchObject({ status: 'invalid' })
    expect(getAuthoringCourse(id).draft.manifest.modules[0].lessons![0].blocks[0].slug).toBe('')
    const duplicate = draft(id, (m) => { m.modules[0].lessons![0].blocks[0].slug = 'same'; m.modules[0].lessons![0].blocks[1].slug = 'same'; return m })
    expect(await saveCourse(id, before.revision, duplicate.draftVersion)).toMatchObject({ status: 'invalid', errors: expect.arrayContaining([expect.stringContaining('/blocks/1/slug: duplicate block slug')]) })
    expect(readDocument(id)).toEqual(before)
  })
})

describe('saving edits and deleting dependencies', () => {
  it('preserves completion, quiz attempts and learner files after renames and cross-module moves', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId, authored = readDocument(id).manifest!
    const lesson = authored.modules[0].lessons![0], quiz = lesson.blocks[1] as QuizBlock, exercise = lesson.blocks[2]
    const learner = join(userWorkspaceRoot(userId), id, 'exercises', exercise.nodeId!, 'exercise.py'); write(learner, '# my solution')
    writeProgress({ ...emptyProgress(id), completedLessons: [lesson.nodeId!], lastLesson: { moduleId: authored.modules[0].nodeId!, lessonId: lesson.nodeId! }, lastItem: { kind: 'lesson', moduleId: authored.modules[0].nodeId!, lessonId: lesson.nodeId! }, quizAttempts: { [quiz.nodeId!]: { submitted: [quiz.options![0].nodeId!], isCorrect: true, at: AT } }, exercises: { [exercise.nodeId!]: { completedAt: AT } } })
    const ref = { moduleId: authored.modules[0].nodeId!, lessonId: lesson.nodeId! }
    insertChat({ id: 'renamed-blocks', courseId: id, startedIn: ref, model: 'model', at: AT })
    appendMessage('renamed-blocks', { role: 'user', text: 'Keep my question', lesson: ref, at: AT })
    const changed = draft(id, (m) => {
      for (const block of m.modules[0].lessons![0].blocks) block.slug = `renamed-${block.slug}`
      return moveElement(editElement(m, lesson.nodeId!, { slug: 'different', title: 'Different' }), lesson.nodeId!, m.modules[2].nodeId!)
    })
    expect(await saveCourse(id, course.revision, changed.draftVersion)).toMatchObject({ status: 'ok' })
    const progress = readProgress(id)
    expect(progress.completedLessons).toEqual([lesson.nodeId])
    expect(progress.lastItem?.moduleId).toBe(authored.modules[2].nodeId)
    expect(progress.quizAttempts[quiz.nodeId!].isCorrect).toBe(true)
    expect(progress.exercises[exercise.nodeId!].completedAt).toBe(AT)
    expect(readFileSync(learner, 'utf8')).toBe('# my solution')
    expect(selectMessages('renamed-blocks')[0].text).toBe('Keep my question')
    const blocks = readDocument(id).manifest!.modules[2].lessons!.at(-1)!.blocks
    expect(blocks.map((block) => block.nodeId)).toEqual(lesson.blocks.map((block) => block.nodeId))
    expect(blocks.every((block) => block.slug?.startsWith('renamed-'))).toBe(true)
  })
  it('confirms lesson deletion and keeps unrelated messages with stable sequence identities', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId, authored = readDocument(id).manifest!
    const lesson = authored.modules[0].lessons![0], later = authored.modules[2].lessons![0]
    const ref = { moduleId: authored.modules[0].nodeId!, lessonId: lesson.nodeId! }, laterRef = { moduleId: authored.modules[2].nodeId!, lessonId: later.nodeId! }
    insertChat({ id: 'mixed', courseId: id, startedIn: ref, model: 'model', at: AT })
    appendMessage('mixed', { role: 'user', text: 'remove me', lesson: ref, at: AT })
    appendMessage('mixed', { role: 'assistant', text: 'keep me', lesson: laterRef, at: AT })
    appendMessage('mixed', { role: 'user', text: 'remove tail', lesson: ref, at: AT })
    db().prepare('UPDATE chats SET generated_title=? WHERE id=?').run('old title', 'mixed')
    writeProgress({ ...emptyProgress(id), completedLessons: [lesson.nodeId!, later.nodeId!], lastLesson: ref, lastItem: { kind: 'lesson', ...ref }, exercises: { [lesson.blocks[2].nodeId!]: { completedAt: AT } } })
    const learner = join(userWorkspaceRoot(userId), id, 'exercises', lesson.blocks[2].nodeId!, 'exercise.py'); write(learner)
    const saved = draft(id, (m) => deleteElement(m, lesson.nodeId!))
    expect(await saveCourse(id, course.revision, saved.draftVersion)).toMatchObject({ status: 'confirmation-required', preview: { messages: 2, workspaces: 1 } })
    expect(selectMessages('mixed')).toHaveLength(3)
    expect(await saveCourse(id, course.revision, saved.draftVersion, true)).toMatchObject({ status: 'ok' })
    expect(selectMessages('mixed')).toMatchObject([{ seq: 1, text: 'keep me' }])
    expect(selectChat('mixed')?.startedIn).toBeNull()
    expect(appendMessage('mixed', { role: 'user', text: 'new', lesson: laterRef, at: AT })).toBe(3)
    expect(readProgress(id).completedLessons).toEqual([later.nodeId])
    expect(readProgress(id).lastItem).toBeUndefined(); expect(existsSync(learner)).toBe(false)
  })
  it('preserves a child moved out of a deleted parent and cascades project files, chats and evidence', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId, authored = readDocument(id).manifest!
    const lesson = authored.modules[0].lessons![0], project = authored.modules[1]
    const ref = { moduleId: authored.modules[0].nodeId!, lessonId: lesson.nodeId! }
    insertChat({ id: 'survives', courseId: id, startedIn: ref, model: 'model', at: AT }); appendMessage('survives', { role: 'user', text: 'keep', lesson: ref, at: AT })
    insertProjectChat({ id: 'project', courseId: id, moduleId: project.nodeId!, model: 'model', reasoning: null, createdAt: AT, updatedAt: AT })
    appendProjectMessage('project', { role: 'user', text: 'review', at: AT })
    const projectPath = courseProjectDir(userId, id, project.nodeId!); write(join(projectPath, 'README.md'))
    write(join(courseProjectStateDir(userId, id), `${project.nodeId}.json`), '{}')
    const saved = draft(id, (m) => deleteElement(deleteElement(moveElement(m, lesson.nodeId!, m.modules[2].nodeId!), m.modules[0].nodeId!), project.nodeId!))
    expect(await saveCourse(id, course.revision, saved.draftVersion, true)).toMatchObject({ status: 'ok' })
    expect(selectMessages('survives')).toHaveLength(1); expect(selectProjectChat('project')).toBeNull(); expect(existsSync(projectPath)).toBe(false)
  })
  it('removes attempts referring to deleted options without regrading surviving attempts', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId
    const quiz = readDocument(id).manifest!.modules[0].lessons![0].blocks[1] as QuizBlock
    writeProgress({ ...emptyProgress(id), quizAttempts: { [quiz.nodeId!]: { submitted: [quiz.options![0].nodeId!], isCorrect: true, at: AT } } })
    const saved = draft(id, (m) => { const q = m.modules[0].lessons![0].blocks[1] as QuizBlock; q.options![0] = { nodeId: randomUUID(), id: 'new', text: 'New', correct: false }; return m })
    await saveCourse(id, course.revision, saved.draftVersion, true)
    expect(readProgress(id).quizAttempts).toEqual({})
  })
  it('deletes removed generated support files while retaining the learner file and untouched chats', async () => {
    const source = manifest(), block = source.modules[0].lessons![0].blocks[2] as import('../src/core/types').ExerciseBlock
    block.extra_files = [{ path: 'support.py', content: 'VALUE=1' }]
    const course = installCourseFixture(source), id = course.courseId, authored = readDocument(id).manifest!
    const exercise = authored.modules[0].lessons![0].blocks[2] as import('../src/core/types').ExerciseBlock
    const workspace = join(userWorkspaceRoot(userId), id, 'exercises', exercise.nodeId!)
    write(join(workspace, 'support.py')); write(join(workspace, 'test_exercise.py')); write(join(workspace, 'exercise.py'), '# learner')
    insertChat({ id: 'empty', courseId: id, startedIn: { moduleId: authored.modules[0].nodeId!, lessonId: authored.modules[0].lessons![0].nodeId! }, model: 'model', at: AT })
    const changed = draft(id, (m) => { const e = m.modules[0].lessons![0].blocks[2] as import('../src/core/types').ExerciseBlock; e.extra_files = []; delete e.tests; return m })
    expect(await saveCourse(id, course.revision, changed.draftVersion, true)).toMatchObject({ status: 'ok' })
    expect(existsSync(join(workspace, 'support.py'))).toBe(false)
    expect(existsSync(join(workspace, 'test_exercise.py'))).toBe(false)
    expect(readFileSync(join(workspace, 'exercise.py'), 'utf8')).toBe('# learner')
    expect(selectChat('empty')).not.toBeNull()
  })
  it('does not overwrite corrupt progress while saving', async () => {
    const course = installCourseFixture(manifest()), saved = draft(course.courseId, (m) => ({ ...m, title: 'Changed' }))
    const path = join(userProgressDir(userId), `${course.courseId}.json`); write(path, '{broken')
    await expect(saveCourse(course.courseId, course.revision, saved.draftVersion)).rejects.toThrow('original file is retained')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(readDocument(course.courseId).manifest!.title).toBe('Project course')
  })
  it('detects a user switch during the asynchronous save without applying edits', async () => {
    const course = installCourseFixture(manifest()), saved = draft(course.courseId, (m) => ({ ...m, title: 'Changed' }))
    let resume!: () => void
    runtime.stop.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve }))
    const saving = saveCourse(course.courseId, course.revision, saved.draftVersion)
    createUser('Other'); resume()
    await expect(saving).rejects.toThrow('active user changed')
    switchUser(userId)
    expect(readDocument(course.courseId).manifest!.title).toBe('Project course')
  })
})

describe('attachments and portable export', () => {
  it('exports flashcard images and authored answers with fresh identities on import and no review state', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId
    const png = join(root, `card-${serial}.png`); write(png, 'card image')
    const upload = await uploadCourseAttachmentPath(id, png, 'image')
    const saved = draft(id, m => {
      m.schema_version = '1.4'
      m.modules[0].lessons![0].flashcards = [{ nodeId: randomUUID(), id: 'card', question: 'Question?', answer: '**Answer**', image: { src: upload.attachment.entry, alt: 'Card image' } }]
      return m
    })
    await saveCourse(id, course.revision, saved.draftVersion)
    const card = readDocument(id).manifest!.modules[0].lessons![0].flashcards![0]
    const archive = join(root, `card-export-${serial}.zip`), destination = join(root, `card-extract-${serial}`)
    await exportCourseZipPath(id, archive); mkdirSync(destination); await extractArchive(archive, destination)
    const exported = JSON.parse(readFileSync(join(destination, 'course.json'), 'utf8'))
    expect(exported).toMatchObject({ schema_version: '1.5', version: '0.1.0' })
    expect(exported.modules[0].lessons[0].flashcards[0]).toEqual({ id: 'card', question: 'Question?', answer: '**Answer**', image: { src: upload.attachment.entry, alt: 'Card image' } })
    expect(existsSync(join(destination, upload.attachment.entry))).toBe(true)
    const imported = await importCourseZip(archive)
    expect(imported.status).toBe('ok')
    if (imported.status === 'ok') expect(readDocument(imported.courseId).manifest!.modules[0].lessons![0].flashcards![0].nodeId).not.toBe(card.nodeId)
    const removed = draft(id, m => { m.modules[0].lessons![0].flashcards = []; return m })
    await saveCourse(id, course.revision + 1, removed.draftVersion, true)
    expect(existsSync(join(packageDirectory(id), upload.attachment.entry))).toBe(false)
  })
  it('uploads complete HTML bundles and exports only the saved version without local or learner data', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId
    const source = join(root, `viz-${serial}`); write(join(source, 'index.html'), '<script src="nested/main.js"></script>'); write(join(source, 'nested/main.js'), 'console.log("hello")')
    const upload = await uploadCourseAttachmentPath(id, source, 'visualization')
    const saved = draft(id, (m) => { m.modules[0].lessons![0].blocks.push({ ...newBlock('visualization', randomUUID), src: upload.attachment.entry } as Block); return m })
    await saveCourse(id, course.revision, saved.draftVersion)
    draft(id, (m) => ({ ...m, title: 'Unsaved title' }))
    write(join(userWorkspaceRoot(userId), id, 'secret.py'), 'learner content')
    const archive = join(root, `export-${serial}.zip`); await exportCourseZipPath(id, archive)
    const extracted = join(root, `extracted-${serial}`); mkdirSync(extracted)
    expect(await extractArchive(archive, extracted)).toEqual({})
    const content = readFileSync(join(extracted, 'course.json'), 'utf8')
    const exported = JSON.parse(content) as CourseManifest
    expect(exported.modules[0].lessons![0].blocks.every((block) => typeof block.slug === 'string')).toBe(true)
    expect(content).not.toContain('nodeId'); expect(content).not.toContain('courseId'); expect(content).not.toContain('Unsaved title'); expect(content).toContain('# solution')
    expect(existsSync(join(extracted, upload.attachment.files.find((f) => f.endsWith('main.js'))!))).toBe(true)
    expect(existsSync(join(extracted, 'secret.py'))).toBe(false)
    const imported = await importCourseZip(archive); expect(imported.status).toBe('ok')
    if (imported.status === 'ok') {
      expect(imported.courseId).not.toBe(id)
      expect(readDocument(imported.courseId).manifest!.modules[0].lessons![0].blocks.map((block) => block.slug)).toEqual(exported.modules[0].lessons![0].blocks.map((block) => block.slug))
    }
  })
  it('retains shared uploads while referenced, removes unused uploads on Save, and rejects symlink bundles', async () => {
    const course = installCourseFixture(manifest()), id = course.courseId
    const png = join(root, `image-${serial}.png`); write(png, 'picture')
    const upload = await uploadCourseAttachmentPath(id, png, 'image')
    const saved = draft(id, (m) => { m.cover_image = upload.attachment.entry; m.modules[0].lessons![0].blocks.push({ nodeId: randomUUID(), type: 'image', slug: 'image', src: upload.attachment.entry }); return m })
    await saveCourse(id, course.revision, saved.draftVersion)
    const after = draft(id, (m) => { m.modules[0].lessons![0].blocks.pop(); return m })
    await saveCourse(id, course.revision + 1, after.draftVersion, true)
    expect(existsSync(join(packageDirectory(id), upload.attachment.entry))).toBe(true)
    const last = draft(id, (m) => { delete m.cover_image; return m })
    await saveCourse(id, course.revision + 2, last.draftVersion)
    expect(existsSync(join(packageDirectory(id), upload.attachment.entry))).toBe(false)
    const bundle = join(root, `symlink-${serial}`); write(join(bundle, 'index.html'), '<p>hello</p>'); symlinkSync(png, join(bundle, 'outside.png'))
    await expect(uploadCourseAttachmentPath(id, bundle, 'visualization')).rejects.toThrow('symlinks')
  })
  it('discard restores the saved version and removes a never-saved course', () => {
    const created = createCourse(); expect(discardCourseDraft(created.document.courseId)).toEqual({ removed: true })
    expect(existsSync(courseDirectory(created.document.courseId))).toBe(false)
    const course = installCourseFixture(manifest())
    draft(course.courseId, (m) => ({ ...m, title: 'Draft' }))
    discardCourseDraft(course.courseId)
    expect(getAuthoringCourse(course.courseId).draft.manifest.title).toBe('Project course')
  })
})

describe('recovery and legacy adoption', () => {
  it.each([false, true])('recovers an interrupted save when its SQL commit marker is %s', (committed) => {
    const course = installCourseFixture(manifest()), id = course.courseId, previous = readDocument(id)
    const next: CourseDocument = { ...previous, revision: previous.revision + 1, manifest: { ...previous.manifest!, title: 'Recovered' } }
    const operationId = randomUUID(), path = join(courseDirectory(id), 'operation.json')
    atomicJSON(path, { id: operationId, courseId: id, document: next, progress: emptyProgress(id), cleanup: [] })
    if (committed) tx((d) => { registerDocument(d, next); d.prepare('INSERT INTO course_operations(id,course_id,revision) VALUES(?,?,?)').run(operationId, id, next.revision) })
    ensureCourseStorage()
    expect(readDocument(id).manifest!.title).toBe(committed ? 'Recovered' : 'Project course')
    expect(existsSync(path)).toBe(false)
    ensureCourseStorage(); expect(readDocument(id).revision).toBe(committed ? next.revision : previous.revision)
  })
  it('migrates old progress, chats, option submissions and learner files idempotently', () => {
    const source = manifest(), slug = source.slug
    const project = source.modules[1] as import('../src/core/types').ProjectModule
    const fingerprint = createHash('sha256').update(projectContextText(source.title, project)).digest('hex')
    write(join(userCoursesDir(userId), slug, 'course.json'), JSON.stringify(source))
    write(join(userProgressDir(userId), `${slug}.json`), JSON.stringify({ courseSlug: slug, completedLessons: ['before/intro'], quizAttempts: { quiz: { submitted: ['a'], isCorrect: true, at: AT } }, exercises: { exercise: { completedAt: AT } }, projects: { [project.slug]: { completedAt: AT, reviewedFingerprint: fingerprint, lastReview: { chatId: 'legacy-project', seq: 0, at: AT, fingerprint } } }, lastLesson: { moduleSlug: 'before', lessonSlug: 'intro' } }))
    write(join(userWorkspaceRoot(userId), slug, 'before', 'intro', 'exercise', 'exercise.py'), '# historical work')
    insertChat({ id: 'legacy', courseId: slug, model: 'model', startedIn: { moduleId: 'before', lessonId: 'intro' }, at: AT }); appendMessage('legacy', { role: 'user', text: 'old question', lesson: { moduleId: 'before', lessonId: 'intro' }, at: AT })
    insertProjectChat({ id: 'legacy-project', courseId: slug, moduleId: project.slug, model: 'model', reasoning: null, createdAt: AT, updatedAt: AT })
    appendProjectMessage('legacy-project', { role: 'context', text: 'Historical project context', project: { moduleId: project.slug, fingerprint }, at: AT })
    write(join(courseProjectDir(userId, slug, project.slug), 'README.md'), '# Learner-written project')
    write(join(courseProjectStateDir(userId, slug), `${project.slug}.json`), JSON.stringify({ initialized: true, seeded: ['README.md'] }))
    reloadCourses(); const summary = listCourses()[0], id = summary.courseId, document = readDocument(id)
    const lesson = document.manifest!.modules[0].lessons![0], quiz = lesson.blocks[1] as QuizBlock
    expect(readProgress(id).completedLessons).toEqual([lesson.nodeId])
    expect(readProgress(id).quizAttempts[quiz.nodeId!].submitted).toEqual([quiz.options![0].nodeId])
    expect(readFileSync(join(userWorkspaceRoot(userId), id, 'exercises', lesson.blocks[2].nodeId!, 'exercise.py'), 'utf8')).toBe('# historical work')
    const projectTarget = { courseId: id, moduleId: document.manifest!.modules[1].nodeId! }
    expect(readProgress(id).projects[projectTarget.moduleId]).toMatchObject({ completedAt: AT, reviewedFingerprint: fingerprint, lastReview: { chatId: 'legacy-project', at: AT } })
    expect(requireCourseProject(projectTarget).fingerprint).toBe(fingerprint)
    expect(selectProjectChat('legacy-project')?.moduleId).toBe(projectTarget.moduleId)
    expect(readFileSync(join(openCourseProject(projectTarget).directory, 'README.md'), 'utf8')).toBe('# Learner-written project')
    expect(selectChat('legacy')?.courseId).toBe(id); expect(selectMessages('legacy')[0].lesson?.lessonId).toBe(lesson.nodeId)
    reloadCourses(); expect(listCourses()[0].courseId).toBe(id)
    expect(existsSync(join(dataDir, 'users', userId, '.course-migration', 'coach-before.db'))).toBe(true)
  })
  it('retries an interrupted migration from its persisted mapping and preserves unmapped originals', () => {
    const slug = 'legacy-retry', source = { ...manifest(), slug }, courseId = randomUUID()
    const identified = identifyManifest(source, randomUUID)
    write(join(userCoursesDir(userId), slug, 'course.json'), JSON.stringify(source))
    const recovery = join(dataDir, 'users', userId, '.course-migration')
    atomicJSON(join(recovery, `${slug}.json`), { courseId, legacySlug: slug, manifest: identified })
    write(join(userProgressDir(userId), `${slug}.json`), JSON.stringify({ courseSlug: slug, completedLessons: ['unknown/lesson'], quizAttempts: {}, exercises: { unmapped: { completedAt: AT } } }))
    // Namespace move already happened before the process stopped; child moves still need recovery.
    write(join(userWorkspaceRoot(userId), courseId, 'before', 'intro', 'exercise', 'exercise.py'), '# recovered')
    reloadCourses(); expect(listCourses()[0].courseId).toBe(courseId)
    const blockId = identified.modules[0].lessons![0].blocks[2].nodeId!
    expect(readFileSync(join(userWorkspaceRoot(userId), courseId, 'exercises', blockId, 'exercise.py'), 'utf8')).toBe('# recovered')
    expect(readFileSync(join(recovery, `${slug}.progress.original`), 'utf8')).toContain('unmapped')
    expect(listCourses()[0].recoveryNotice).toContain('original data is retained')
    expect(existsSync(join(recovery, 'coach-before.db'))).toBe(true)
    reloadCourses(); expect(listCourses()[0].courseId).toBe(courseId)
  })
  it('retains ambiguous legacy lesson data without guessing or blocking other courses', () => {
    const source = manifest(), slug = 'ambiguous'
    source.slug = slug
    source.modules[0].lessons!.push(structuredClone(source.modules[0].lessons![0]))
    write(join(userCoursesDir(userId), slug, 'course.json'), JSON.stringify(source))
    write(join(userWorkspaceRoot(userId), slug, 'before', 'intro', 'exercise', 'exercise.py'), '# ambiguous original')
    write(join(userProgressDir(userId), `${slug}.json`), JSON.stringify({ completedLessons: ['before/intro'], quizAttempts: {}, exercises: {}, projects: {} }))
    reloadCourses(); const summary = listCourses()[0]
    expect(summary.recoveryNotice).toContain('original data is retained')
    expect(readProgress(summary.courseId).completedLessons).toEqual([])
    expect(readFileSync(join(userWorkspaceRoot(userId), summary.courseId, 'before', 'intro', 'exercise', 'exercise.py'), 'utf8')).toBe('# ambiguous original')
    expect(readDocument(summary.courseId).recoveryNotes!.join(' ')).toContain('Ambiguous lesson')
    expect(getCourse(summary.courseId)?.flatLessons.length).toBe(4)
  })
  it('keeps invalid legacy packages recoverable instead of dropping them from the library', () => {
    write(join(userCoursesDir(userId), 'broken', 'course.json'), '{invalid')
    reloadCourses()
    expect(listCourses()).toHaveLength(1); expect(listCourses()[0].error).toContain('JSON')
    expect(readFileSync(join(dataDir, 'users', userId, '.course-migration', 'broken.package', 'course.json'), 'utf8')).toBe('{invalid')
  })
  it('removes a saved course and its draft without affecting another UUID with the same slug', async () => {
    const a = installCourseFixture(manifest()), b = installCourseFixture(manifest())
    draft(a.courseId, (m) => ({ ...m, title: 'Draft' }))
    await removeCourse(a.courseId)
    expect(getCourse(a.courseId)).toBeUndefined(); expect(getCourse(b.courseId)?.title).toBe('Project course')
  })
})
