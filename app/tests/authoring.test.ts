// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authoringContext, authoringManifest, parseAuthoringManifest } from '../src/core/authoring/document'
import { courseNodes, portableManifest, UUID, DRAFT_REF } from '../src/core/course-document'
import { responseRequest } from '../src/core/ai-request'
import { projectCourse } from './helpers/project'
import { installCourseFixture } from './helpers/course'
import type { ChatStreamOptions } from '../src/main/openai'
const root = mkdtempSync(join(tmpdir(), 'opencourse-authoring-'))
let dataDir = join(root, 'data'), serial = 0
const mocked = vi.hoisted(() => ({ stream: vi.fn(), title: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => dataDir, getAppPath: () => resolve('.'), on: () => {} }, dialog: {} }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => 'sk-test' }))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))
vi.mock('../src/main/chattitles', () => ({ cancelChatTitles: () => {}, generateChatTitle: mocked.title }))
vi.mock('../src/main/openai', () => ({ streamChat: mocked.stream }))
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db, SCHEMA_VERSION } = await import('../src/main/db')
const { createCourse, getAuthoringCourse, saveDraft, saveCourse, discardCourseDraft, exportCourseZipPath, uploadCourseAttachmentPath } = await import('../src/main/course-authoring')
const { beginAuthoringTurn, authoringRunState } = await import('../src/main/authoring-state')
const { runAuthoringTool } = await import('../src/main/authoring-tools')
const { cancelAllAuthoringChats, cancelAuthoringChat, createAuthoringChat, getAuthoringChat, listAuthoringChats, sendAuthoringMessage } = await import('../src/main/authoring-chat')
const { packageDirectory } = await import('../src/main/course-store')
const { removeCourse } = await import('../src/main/import')
const { readProgress, writeProgress } = await import('../src/main/progress')
const { emptyProgress } = await import('../src/core/progress')
const { extractArchive } = await import('../src/main/unzip')
const { appendAuthoringMessage } = await import('../src/main/authoring-chatdb')
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
beforeEach(() => {
  cancelAllAuthoringChats(); closeDb(); dataDir = join(root, `data-${++serial}`); createUser('Author')
  sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, send: vi.fn() })
  mocked.stream.mockReset(); mocked.title.mockReset().mockResolvedValue(undefined)
})
afterAll(() => { cancelAllAuthoringChats(); closeDb(); rmSync(root, { recursive: true, force: true }) })
function fixture() { const created = createCourse(); return { courseId: created.document.courseId, ...created } }
async function tool(courseId: string, name: string, args: unknown) {
  const lease = beginAuthoringTurn(courseId, 'test', () => {})
  try { return JSON.parse(await runAuthoringTool(courseId, name, args, lease.token, new AbortController().signal)) }
  finally { lease.release() }
}
async function settle() { for (let n = 0; n < 200; n++) { if (sender.send.mock.calls.some(([channel]) => ['authoringChat:done', 'authoringChat:error'].includes(channel))) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('Authoring did not finish') }
const manifest = () => projectCourse()

describe('authoring draft tools and permanent identities', () => {
  it('generates every block type and project supporting files without model-supplied local identities', async () => {
    const { courseId } = fixture(), course = manifest()
    const image = await tool(courseId, 'write_asset_bundle', { kind: 'image', entry: 'diagram.svg', files: [{ path: 'diagram.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="20">Diagram</text></svg>' }] })
    const viz = await tool(courseId, 'write_asset_bundle', { kind: 'visualization', entry: 'index.html', files: [{ path: 'index.html', content: '<p>Interactive lesson</p>' }] })
    const videoPath = join(root, `uploaded-${serial}.mp4`); writeFileSync(videoPath, 'existing uploaded video')
    const video = await uploadCourseAttachmentPath(courseId, videoPath, 'video')
    course.modules[0].lessons![0].blocks.push(
      { type: 'quiz', slug: 'quiz', id: 'check-understanding', kind: 'single', question: 'Which?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] },
      { type: 'exercise', slug: 'exercise', id: 'practice', title: 'Practice', prompt: 'Write a function', starter_code: '# start', solution: '# solution', tests: 'assert True', verification_instructions: 'Pass the tests', extra_files: [{ path: 'support.py', content: 'VALUE = 1' }] },
      { type: 'image', slug: 'diagram', src: image.result.entry, alt: 'Diagram' },
      { type: 'video', slug: 'video', src: video.attachment.entry },
      { type: 'visualization', slug: 'interactive', src: viz.result.entry, title: 'Interactive' }
    )
    expect((await tool(courseId, 'set_course', { course })).ok).toBe(true)
    const draft = getAuthoringCourse(courseId).draft
    expect(courseNodes(draft.manifest).every(node => DRAFT_REF.test(node.id))).toBe(true)
    expect((await tool(courseId, 'validate_course', {})).result.errors).toEqual([])
    expect(await saveCourse(courseId, 0, draft.draftVersion)).toMatchObject({ status: 'ok' })
    closeDb()
    const reopened = getAuthoringCourse(courseId).document.manifest!
    expect(portableManifest(reopened)).toEqual({ ...course, schema_version: '1.5', version: '0.1.0' })
    expect(reopened.modules[0].lessons![0].blocks.map(block => block.type)).toEqual(['markdown', 'quiz', 'exercise', 'image', 'video', 'visualization'])
    expect(courseNodes(reopened).every(node => UUID.test(node.id))).toBe(true)
  })
  it('allocates permanent UUIDs on save and remaps chat targets without changing existing identities', async () => {
    const { courseId } = fixture()
    expect((await tool(courseId, 'set_course', { course: manifest() })).ok).toBe(true)
    const before = getAuthoringCourse(courseId)
    expect(courseNodes(before.draft.manifest).every(n => DRAFT_REF.test(n.id))).toBe(true)
    expect(before.document.manifest).toBeNull()
    const chat = createAuthoringChat(courseId), ref = before.draft.manifest.modules[0].lessons![0].nodeId!
    appendAuthoringMessage(chat.id, { role: 'user', text: 'Improve this', authoring: { target: { kind: 'lesson', ref }, label: 'Lesson', draftVersion: before.draft.draftVersion }, at: 'now' })
    const saved = await saveCourse(courseId, 0, before.draft.draftVersion)
    if (saved.status !== 'ok') throw new Error(JSON.stringify(saved))
    expect(saved.nodeRefMap?.[ref]).toMatch(UUID)
    expect(getAuthoringChat(chat.id).messages[0].authoring?.target).toEqual({ kind: 'lesson', ref: saved.nodeRefMap![ref] })
    const after = getAuthoringCourse(courseId)
    expect(courseNodes(after.document.manifest).every(n => UUID.test(n.id))).toBe(true)
    expect(portableManifest(after.document.manifest!)).toEqual({ ...manifest(), schema_version: '1.5', version: '0.1.0' })
    await tool(courseId, 'set_course', { course: { ...authoringManifest(after.draft.manifest), title: 'Renamed' } })
    await saveCourse(courseId, 1, getAuthoringCourse(courseId).draft.draftVersion)
    expect(courseNodes(getAuthoringCourse(courseId).document.manifest).map(n => n.id)).toEqual(courseNodes(after.document.manifest).map(n => n.id))
  })
  it('rejects malformed shapes, UUID injection, stale and duplicate refs without losing the draft', async () => {
    const { courseId } = fixture(); await tool(courseId, 'set_course', { course: manifest() })
    const before = getAuthoringCourse(courseId).draft
    expect((await tool(courseId, 'update_element', { fields: { modules: null } })).ok).toBe(false)
    expect((await tool(courseId, 'update_element', { ref: 'stale', fields: { title: 'No' } })).ok).toBe(false)
    expect((await tool(courseId, 'set_course', { course: { ...manifest(), modules: [{ ...manifest().modules[0], nodeId: 'fake' }] } })).ok).toBe(false)
    const annotated = authoringManifest(before.manifest); annotated.modules.push(annotated.modules[0])
    expect(() => parseAuthoringManifest(annotated, before.manifest)).toThrow('duplicate')
    expect(getAuthoringCourse(courseId).draft).toEqual(before)
    const block = before.manifest.modules[0].lessons![0].blocks[0]
    expect((await tool(courseId, 'update_element', { ref: block.nodeId, fields: { content: '# New content' } })).ok).toBe(true)
    expect(getAuthoringCourse(courseId).draft.manifest.modules[0].lessons![0].blocks[0]).toMatchObject({ nodeId: block.nodeId, content: '# New content' })
  })
  it('adds incomplete scaffolds, duplicates subtrees, moves/reorders and deletes elements', async () => {
    const { courseId } = fixture()
    expect((await tool(courseId, 'add_element', { element: { slug: 'one', title: 'One', lessons: [] } })).ok).toBe(true)
    const first = getAuthoringCourse(courseId).draft.manifest.modules[0].nodeId!
    await tool(courseId, 'add_element', { parent_ref: first, element: { slug: 'lesson', title: 'Lesson', blocks: [] } })
    const lesson = getAuthoringCourse(courseId).draft.manifest.modules[0].lessons![0].nodeId!
    await tool(courseId, 'add_element', { parent_ref: lesson, element: { type: 'markdown', slug: 'text', content: 'Hello' } })
    const duplicated = await tool(courseId, 'duplicate_element', { ref: first }); expect(duplicated.ok).toBe(true)
    const second = duplicated.result.ref
    expect((await tool(courseId, 'move_element', { ref: lesson, parent_ref: second, index: 0 })).ok).toBe(true)
    expect((await tool(courseId, 'move_element', { ref: second, index: 0 })).ok).toBe(true)
    expect((await tool(courseId, 'delete_element', { ref: first })).ok).toBe(true)
    const state = getAuthoringCourse(courseId).draft.manifest
    expect(state.modules).toHaveLength(1); expect(state.modules[0].nodeId).toBe(second); expect(state.modules[0].lessons![0].nodeId).toBe(lesson)
  })
  it('reads the shipped format/schema and reports invalid draft errors', async () => {
    const { courseId } = fixture()
    expect((await tool(courseId, 'get_course_format', { section: 'format' })).result.text).toContain('course.json')
    expect((await tool(courseId, 'get_course_format', { section: 'schema' })).result.text).toContain('schema_version')
    expect((await tool(courseId, 'validate_course', {})).result.errors.length).toBeGreaterThan(0)
    expect(await saveCourse(courseId, 0, 0)).toMatchObject({ status: 'invalid' })
  })
  it('creates, previews, edits and reorders flashcards while keeping their lesson binding', async () => {
    const { courseId } = fixture()
    await tool(courseId, 'set_course', { course: { ...manifest(), schema_version: '1.4' } })
    const source = getAuthoringCourse(courseId).draft.manifest, lesson = source.modules[0].lessons![0], later = source.modules[2].lessons![0]
    expect((await tool(courseId, 'add_element', { parent_ref: lesson.nodeId, collection: 'flashcards', element: { id: 'one', question: '', answer: '' } })).ok).toBe(true)
    const card = getAuthoringCourse(courseId).draft.manifest.modules[0].lessons![0].flashcards![0]
    expect((await tool(courseId, 'update_element', { ref: card.nodeId, fields: { question: 'What?', answer: 'This.' } })).ok).toBe(true)
    const read = await tool(courseId, 'read_course', { ref: card.nodeId })
    expect(read.result.course).toMatchObject({ ref: card.nodeId, question: 'What?', answer: 'This.' })
    const copied = await tool(courseId, 'duplicate_element', { ref: card.nodeId })
    expect(copied.ok).toBe(true)
    expect((await tool(courseId, 'move_element', { ref: card.nodeId, parent_ref: later.nodeId, index: 0 })).ok).toBe(false)
    expect((await tool(courseId, 'move_element', { ref: card.nodeId, parent_ref: lesson.nodeId, index: 1 })).ok).toBe(true)
    expect((await tool(courseId, 'delete_element', { ref: copied.result.ref })).ok).toBe(true)
    expect((await tool(courseId, 'validate_course', {})).result.errors).toEqual([])
    const before = getAuthoringCourse(courseId).draft.manifest
    expect(authoringContext(before, { kind: 'flashcard', ref: card.nodeId! }, 1).selected).toMatchObject({ ref: card.nodeId })
    const state = getAuthoringCourse(courseId)
    expect(await saveCourse(courseId, state.document.revision, state.draft.draftVersion)).toMatchObject({ status: 'ok' })
    expect(getAuthoringCourse(courseId).document.manifest!.modules[0].lessons![0].flashcards![0].answer).toBe('This.')
  })
  it('versions generated bundles, preserves saved files on discard and exports dependencies', async () => {
    const { courseId } = fixture()
    const bundle = { kind: 'visualization', entry: 'other.html', files: [{ path: 'index.html', content: 'Index' }, { path: 'other.html', content: '<script src="app.js"></script>' }, { path: 'app.js', content: 'console.log(1)' }] }
    const uploaded = await tool(courseId, 'write_asset_bundle', bundle); expect(uploaded.ok).toBe(true)
    expect(uploaded.result.entry).toContain('other.html')
    const course = manifest(); course.modules[0].lessons![0].blocks.push({ type: 'visualization', slug: 'viz', src: uploaded.result.entry, title: 'Demo' })
    await tool(courseId, 'set_course', { course }); await saveCourse(courseId, 0, getAuthoringCourse(courseId).draft.draftVersion)
    const changed = await tool(courseId, 'write_asset_bundle', { ...bundle, files: [{ path: 'other.html', content: 'Changed' }] })
    expect(changed.result.entry).not.toBe(uploaded.result.entry)
    expect(readFileSync(join(packageDirectory(courseId), uploaded.result.entry), 'utf8')).toContain('<script')
    discardCourseDraft(courseId)
    expect(existsSync(join(packageDirectory(courseId), changed.result.entry))).toBe(false)
    const archive = join(root, `export-${serial}.zip`), destination = join(root, `extracted-${serial}`)
    await exportCourseZipPath(courseId, archive); expect((await extractArchive(archive, destination)).error).toBeUndefined()
    expect(readFileSync(join(destination, 'course.json'), 'utf8')).not.toMatch(/nodeId|draft:|authoring/)
    expect(existsSync(join(destination, uploaded.result.entry.replace('other.html', 'app.js')))).toBe(true)
    expect((await tool(courseId, 'read_asset', { path: uploaded.result.entry })).result.text).toContain('<script')
  })
  it('rejects unsafe/binary/duplicate asset paths and expired authoring leases', async () => {
    const { courseId } = fixture()
    for (const path of ['../evil.html', '/evil.html', 'image.png', 'index.html/../other.html']) expect((await tool(courseId, 'write_asset_bundle', { kind: 'visualization', entry: path, files: [{ path, content: 'bad' }] })).ok).toBe(false)
    expect((await tool(courseId, 'write_asset_bundle', { kind: 'image', entry: 'a.svg', files: [{ path: 'a.svg', content: 'x' }, { path: 'a.svg', content: 'y' }] })).ok).toBe(false)
    const lease = beginAuthoringTurn(courseId, 'stopped', () => {}); lease.release()
    expect(JSON.parse(await runAuthoringTool(courseId, 'add_element', { element: { slug: 'no', title: 'No', lessons: [] } }, lease.token, new AbortController().signal)).ok).toBe(false)
    expect(getAuthoringCourse(courseId).draft.manifest.modules).toEqual([])
  })
  it('preserves learner progress and history through save/discard, cascading only on deletion', async () => {
    const courseId = installCourseFixture(manifest()).courseId, before = getAuthoringCourse(courseId), lesson = before.document.manifest!.modules[0].lessons![0].nodeId!
    writeProgress({ ...emptyProgress(courseId), completedLessons: [lesson] }); const chat = createAuthoringChat(courseId)
    await tool(courseId, 'update_element', { ref: lesson, fields: { title: 'Revised lesson' } })
    await saveCourse(courseId, before.document.revision, getAuthoringCourse(courseId).draft.draftVersion)
    expect(readProgress(courseId).completedLessons).toContain(lesson)
    await tool(courseId, 'update_element', { fields: { title: 'Unsaved title' } })
    discardCourseDraft(courseId)
    expect(listAuthoringChats(courseId)[0].id).toBe(chat.id)
    await removeCourse(courseId); expect(db().prepare('SELECT COUNT(*) AS n FROM authoring_chats').get()).toMatchObject({ n: 0 })
  })
})

describe('authoring conversation context and lifecycle', () => {
  it('preserves preview and answer quote sources in history and model input', async () => {
    const { courseId } = fixture(); await tool(courseId, 'set_course', { course: manifest() })
    const chat = createAuthoringChat(courseId), state = getAuthoringCourse(courseId)
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => { options.onDelta('Done'); return { text: 'Done', aborted: false, output: [] } })
    await sendAuthoringMessage(sender as never, chat.id, 'Explain this', { kind: 'overview' }, 0, state.draft.draftVersion, { text: '  selected preview text  ', from: 'preview' }); await settle()
    expect(getAuthoringChat(chat.id).messages.find(m => m.role === 'user')?.quote).toEqual({ text: 'selected preview text', from: 'preview' })
    expect(JSON.stringify(mocked.stream.mock.calls[0][0].input)).toContain('Quoted course preview passage:')
    expect(JSON.stringify(mocked.stream.mock.calls[0][0].input)).toContain('selected preview text')
    sender.send.mockClear()
    await sendAuthoringMessage(sender as never, chat.id, 'Expand on this answer', { kind: 'overview' }, 0, state.draft.draftVersion, { text: 'earlier answer', from: 'answer' }); await settle()
    expect(getAuthoringChat(chat.id).messages.filter(m => m.role === 'user').at(-1)?.quote).toEqual({ text: 'earlier answer', from: 'answer' })
    expect(JSON.stringify(mocked.stream.mock.calls.at(-1)![0].input)).toContain('Quoted earlier answer:')
  })
  it('preserves successful edits and releases the course after a provider failure', async () => {
    const { courseId } = fixture(), chat = createAuthoringChat(courseId)
    mocked.stream.mockImplementationOnce(async () => ({ text: '', aborted: false, output: [{ type: 'function_call', call_id: 'create', name: 'set_course', arguments: JSON.stringify({ course: manifest() }) }] }))
      .mockImplementationOnce(async (options: ChatStreamOptions) => { options.onDelta('Created the draft'); throw new Error('Provider request failed') })
    await sendAuthoringMessage(sender as never, chat.id, 'Create a course', { kind: 'overview' }, 0, 0); await settle()
    const draft = getAuthoringCourse(courseId).draft
    expect(portableManifest(draft.manifest)).toEqual(manifest())
    expect(authoringRunState(courseId).chatId).toBeNull()
    expect(getAuthoringChat(chat.id).messages.at(-1)).toMatchObject({ text: 'Created the draft', status: 'failed' })
    expect(sender.send.mock.calls).toContainEqual(['authoringChat:error', chat.id, 'Provider request failed'])
    expect(await saveCourse(courseId, 0, draft.draftVersion)).toMatchObject({ status: 'ok' })
  })
  it('captures context on each message and lets the same tab edit nonselected blocks', async () => {
    const { courseId } = fixture(); await tool(courseId, 'set_course', { course: manifest() })
    const chat = createAuthoringChat(courseId), original = getAuthoringCourse(courseId), block = original.draft.manifest.modules[0].lessons![0].blocks[0]
    mocked.stream.mockImplementationOnce(async (options: ChatStreamOptions) => {
      expect(JSON.stringify(options.input)).toContain('Course overview'); expect(options.toolNamespace?.name).toBe('authoring')
      return { text: '', aborted: false, output: [{ type: 'function_call', call_id: 'edit', name: 'update_element', arguments: JSON.stringify({ ref: block.nodeId, fields: { content: 'Edited another block' } }) }] }
    }).mockImplementation(async (options: ChatStreamOptions) => { options.onDelta('Done'); return { text: 'Done', aborted: false, output: [] } })
    expect(await sendAuthoringMessage(sender as never, chat.id, 'Edit that lesson', { kind: 'overview' }, 0, original.draft.draftVersion)).toMatchObject({ status: 'ok' }); await settle()
    expect(getAuthoringCourse(courseId).draft.manifest.modules[0].lessons![0].blocks[0]).toMatchObject({ content: 'Edited another block' })
    expect(db().prepare('SELECT COUNT(*) AS n FROM authoring_tool_calls').get()).toMatchObject({ n: 1 })
    sender.send.mockClear(); const latest = getAuthoringCourse(courseId)
    await sendAuthoringMessage(sender as never, chat.id, 'Now edit this', { kind: 'block', ref: block.nodeId! }, 0, latest.draft.draftVersion); await settle()
    expect(getAuthoringChat(chat.id).messages.filter(m => m.role === 'user').map(m => m.authoring?.target.kind)).toEqual(['overview', 'block'])
    expect(JSON.stringify(mocked.stream.mock.calls.at(-1)![0].input)).toContain('Edited another block')
    expect(authoringContext(latest.draft.manifest, { kind: 'block', ref: block.nodeId! }, latest.draft.draftVersion).ancestry).toHaveLength(2)
  })
  it('serializes tabs and manual writes, keeping successful edits on Stop and rejecting late tool calls', async () => {
    const { courseId } = fixture(); await tool(courseId, 'set_course', { course: manifest() })
    const chat = createAuthoringChat(courseId), another = createAuthoringChat(courseId), snapshot = getAuthoringCourse(courseId)
    let resume!: () => void
    mocked.stream.mockImplementationOnce(async () => ({ text: '', aborted: false, output: [{ type: 'function_call', call_id: 'title', name: 'update_element', arguments: '{"fields":{"title":"AI revised"}}' }] }))
      .mockImplementationOnce(async (options: ChatStreamOptions) => { options.onDelta('Partial response'); await new Promise<void>(r => { resume = r }); return { text: 'Partial response', aborted: false, output: [{ type: 'function_call', call_id: 'late', name: 'update_element', arguments: '{"fields":{"title":"Late edit"}}' }] } })
    await sendAuthoringMessage(sender as never, chat.id, 'Improve this', { kind: 'overview' }, 0, snapshot.draft.draftVersion)
    await vi.waitFor(() => expect(getAuthoringCourse(courseId).draft.manifest.title).toBe('AI revised'))
    expect(await sendAuthoringMessage(sender as never, another.id, 'Also edit', { kind: 'overview' }, 0, snapshot.draft.draftVersion)).toEqual({ status: 'busy' })
    expect(() => saveDraft(courseId, snapshot.draft.manifest, 0, snapshot.draft.draftVersion)).toThrow('assistant')
    await expect(saveCourse(courseId, 0, snapshot.draft.draftVersion)).rejects.toThrow('assistant')
    await expect(uploadCourseAttachmentPath(courseId, '/tmp/unused', 'image')).rejects.toThrow('assistant')
    expect(() => discardCourseDraft(courseId)).toThrow('assistant')
    cancelAuthoringChat(chat.id); resume(); await new Promise(r => setImmediate(r))
    expect(getAuthoringCourse(courseId).draft.manifest.title).toBe('AI revised')
    expect(getAuthoringChat(chat.id).messages.at(-1)).toMatchObject({ text: 'Partial response', status: 'stopped' })
    expect(authoringRunState(courseId).chatId).toBeNull(); expect(mocked.title).not.toHaveBeenCalled()
  })
  it('rejects stale versions/missing targets without model requests and deletes new-draft chats on discard', async () => {
    const { courseId } = fixture(), chat = createAuthoringChat(courseId)
    expect(await sendAuthoringMessage(sender as never, chat.id, 'Hi', { kind: 'overview' }, 0, 99)).toMatchObject({ status: 'failed' })
    expect(await sendAuthoringMessage(sender as never, chat.id, 'Hi', { kind: 'block', ref: 'missing' }, 0, 0)).toMatchObject({ status: 'failed' })
    expect(mocked.stream).not.toHaveBeenCalled(); closeDb(); expect(listAuthoringChats(courseId)[0].id).toBe(chat.id)
    discardCourseDraft(courseId); expect(db().prepare('SELECT COUNT(*) AS n FROM authoring_chats').get()).toMatchObject({ n: 0 })
  })
  it('never executes delayed writes against another user', async () => {
    const { courseId } = fixture(), chat = createAuthoringChat(courseId); let resume!: () => void
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => { options.onDelta('Partial'); await new Promise<void>(r => { resume = r }); return { text: 'Partial', aborted: false, output: [{ type: 'function_call', call_id: 'late', name: 'set_course', arguments: JSON.stringify({ course: manifest() }) }] } })
    await sendAuthoringMessage(sender as never, chat.id, 'Create course', { kind: 'overview' }, 0, 0); await new Promise(r => setImmediate(r))
    cancelAllAuthoringChats(); closeDb(); const other = createUser('Other'); switchUser(other.id); resume(); await new Promise(r => setImmediate(r))
    expect(db().prepare('SELECT COUNT(*) AS n FROM authoring_tool_calls').get()).toMatchObject({ n: 0 }); expect(authoringRunState(courseId).chatId).toBeNull()
  })
  it('adapts authoring namespaces and upgrades v10 without losing chats', () => {
    const body = responseRequest('chatgpt', { model: 'model', input: [], tools: [{ type: 'function', name: 'set_course' }], toolNamespace: { name: 'authoring', description: 'Edit course' } })
    expect(body.tools).toMatchObject([{ type: 'namespace', name: 'authoring', description: 'Edit course' }])
    expect(responseRequest('chatgpt', { model: 'model', input: [], tools: [{}] }).tools).toMatchObject([{ name: 'project' }])
    const { courseId } = fixture(); createAuthoringChat(courseId); db().exec('PRAGMA user_version=10'); closeDb()
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION }); expect(listAuthoringChats(courseId)).toHaveLength(1)
  })
})
