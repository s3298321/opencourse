import { installCourseFixture } from './helpers/course'
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectCourse } from './helpers/project'
import type { ChatStreamOptions } from '../src/main/openai'
import { TITLE_INSTRUCTIONS } from '../src/core/sidechat/title'
const root = mkdtempSync(join(tmpdir(), 'opencourse-project-main-'))
let dataDir = join(root, 'data')
const mocked = vi.hoisted(() => ({ stream: vi.fn(), title: vi.fn(), key: { value: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' }, editor: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => dataDir, on: () => {} }, shell: { showItemInFolder: vi.fn() } }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => mocked.key.value }))
vi.mock('../src/main/openai', () => ({ streamChat: (options: ChatStreamOptions) => {
  const first = options.input[0]
  return first && 'content' in first && first.content === TITLE_INSTRUCTIONS ? mocked.title(options) : mocked.stream(options)
} }))
vi.mock('../src/main/editors', () => ({ installedEditors: () => [{ id: 'zed', label: 'Zed', bundlePath: '/Applications/Zed.app' }], editorPreference: () => 'zed', launchProjectEditor: mocked.editor }))
const { createUser, switchUser } = await import('../src/main/users')
const { userCoursesDir, courseProjectDir } = await import('../src/main/paths')
const { closeDb, db, SCHEMA_VERSION } = await import('../src/main/db')
const { openCourseProject, openProjectEditor } = await import('../src/main/courseprojects')
const { cancelAllProjectChats, cancelProjectChat, createProjectChat, deleteProjectChat, getProjectChat, listProjectChats, sendProjectMessage } = await import('../src/main/projectchat')
const { readProgress } = await import('../src/main/progress')
const { selectProjectChat } = await import('../src/main/projectchatdb')
const { removeCourse } = await import('../src/main/import')
const { writePreferences } = await import('../src/main/preferences')
const target = { courseId: 'projects-demo', moduleId: 'portfolio-project' }
let userId = ''
let count = 0
let sender: EventEmitter & { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
beforeEach(() => {
  cancelAllProjectChats(); closeDb()
  dataDir = join(root, `data-${++count}`)
  userId = createUser('Learner').id
  const course = installCourseFixture(projectCourse())
  Object.assign(target, { courseId: course.courseId, moduleId: course.modules[1].slug })
  sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  mocked.stream.mockReset(); mocked.editor.mockReset(); mocked.key.value = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  mocked.title.mockReset().mockResolvedValue({ text: 'Project Design Review', aborted: false, output: [] })
})
afterAll(() => { cancelAllProjectChats(); closeDb(); rmSync(root, { recursive: true, force: true }) })
async function settle(): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (sender.send.mock.calls.some(([channel]) => ['projectChat:done', 'projectChat:error'].includes(channel))) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Project assistant did not finish.')
}
describe('persistent course project workspaces', () => {
  it('seeds once without a key and preserves edits, deletions and replacement course starters', () => {
    mocked.key.value = ''
    const opened = openCourseProject(target)
    expect(opened.preferredEditor).toBe('zed')
    expect(readFileSync(join(opened.directory, 'README.md'), 'utf8')).toContain('Design choices')
    writeFileSync(join(opened.directory, 'README.md'), 'My work')
    rmSync(join(opened.directory, 'src', 'portfolio.md'))
    openCourseProject(target)
    const replacement = projectCourse(); const mod = replacement.modules[1]
    if (mod.type === 'project') mod.project.starter_files!.push({ path: 'new.md', content: 'new seed' })
    installCourseFixture(replacement, target.courseId)
    openCourseProject(target)
    expect(readFileSync(join(opened.directory, 'README.md'), 'utf8')).toBe('My work')
    expect(existsSync(join(opened.directory, 'src', 'portfolio.md'))).toBe(false)
    expect(existsSync(join(opened.directory, 'new.md'))).toBe(false)
  })
  it('reports a missing initialized folder and recreates only on explicit request', () => {
    const opened = openCourseProject(target)
    rmSync(opened.directory, { recursive: true })
    expect(openCourseProject(target).missing).toBe(true)
    expect(existsSync(opened.directory)).toBe(false)
    expect(openCourseProject(target, true).missing).toBe(false)
    expect(existsSync(join(opened.directory, 'README.md'))).toBe(true)
  })
  it('rejects project root symlinks and launches editors with a main-derived folder', async () => {
    const opened = openCourseProject(target)
    await openProjectEditor(target, 'zed')
    expect(mocked.editor).toHaveBeenCalledWith(opened.directory, 'zed')
    const external = join(root, 'external'); mkdirSync(external, { recursive: true })
    rmSync(opened.directory, { recursive: true }); symlinkSync(external, opened.directory)
    expect(() => openCourseProject(target)).toThrow('regular directory')
    await expect(openProjectEditor(target, 'zed')).rejects.toThrow('Symlinks')
    expect(existsSync(join(external, 'README.md'))).toBe(false)
  })
  it('rejects symlinked owned ancestors and initialization metadata before writing', () => {
    const outside = join(root, `outside-${count}`); mkdirSync(outside)
    const metadata = join(dataDir, 'users', userId, 'course-project-state')
    symlinkSync(outside, metadata)
    expect(() => openCourseProject(target)).toThrow('symlinks are excluded')
    expect(existsSync(join(outside, target.courseId))).toBe(false)
    rmSync(metadata)
    const user = join(dataDir, 'users', userId)
    // Keep the imported course reachable to isolate the owned-ancestor check.
    mkdirSync(join(outside, 'courses', target.courseId), { recursive: true })
    writeFileSync(join(outside, 'courses', target.courseId, 'document.json'), readFileSync(join(userCoursesDir(userId), target.courseId, 'document.json')))
    rmSync(user, { recursive: true }); symlinkSync(outside, user)
    expect(() => openCourseProject(target)).toThrow('symlinks are excluded')
    expect(existsSync(join(outside, 'course-projects'))).toBe(false)
  })
})
describe('project assistant scope, evidence and lifecycle', () => {
  it('starts new project chats with the saved chat defaults and preserves existing chats', () => {
    const existing = createProjectChat(target)
    writePreferences({ defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high' })
    expect(createProjectChat(target)).toMatchObject({ model: 'gpt-5.1', reasoning: 'high' })
    expect(getProjectChat(existing.id).chat).toMatchObject({ model: 'gpt-5.6-terra', reasoning: null })
  })
  it('stops an active review before deleting its course and never restores progress or transcripts', async () => {
    const opened = openCourseProject(target)
    const chat = createProjectChat(target)
    let release!: () => void
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('Partial feedback')
      await new Promise<void>((resolve) => { release = resolve })
      expect(options.signal?.aborted).toBe(true)
      return { text: 'Partial feedback', aborted: true, output: [] }
    })
    await sendProjectMessage(sender as never, chat.id, '', undefined, true)
    await new Promise((resolve) => setImmediate(resolve))
    await removeCourse(target.courseId)
    expect(selectProjectChat(chat.id)).toBeNull()
    expect(existsSync(opened.directory)).toBe(false)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(selectProjectChat(chat.id)).toBeNull()
    expect(readProgress(target.courseId).projects).toEqual({})
    expect(db().prepare('SELECT COUNT(*) AS n FROM course_project_messages').get()).toMatchObject({ n: 0 })
  })
  it('implicitly sends the full requirements, reads live files, persists evidence and records review provenance', async () => {
    openCourseProject(target)
    const chat = createProjectChat(target)
    const reasoning = { type: 'reasoning', encrypted_content: 'opaque' }
    mocked.stream.mockImplementationOnce(async (options: ChatStreamOptions) => {
      expect(JSON.stringify(options.input)).toContain('README explains the design choices.')
      expect(options.tools).toHaveLength(3)
      return { text: '', aborted: false, output: [reasoning, { type: 'function_call', call_id: 'read1', name: 'read_project_file', arguments: '{"path":"README.md","start_line":1,"max_lines":100}' }] }
    }).mockImplementationOnce(async (options: ChatStreamOptions) => {
      expect(options.input).toContainEqual(reasoning)
      expect(JSON.stringify(options.input)).toContain('1: # Design choices')
      options.onDelta('The README still needs your design explanation.')
      return { text: 'The README still needs your design explanation.', aborted: false, output: [] }
    })
    expect(await sendProjectMessage(sender as never, chat.id, '', undefined, true)).toMatchObject({ status: 'ok' })
    await settle()
    const thread = getProjectChat(chat.id)
    expect(thread.messages.map((m) => m.role)).toEqual(['context', 'user', 'assistant'])
    expect(thread.messages[0].project?.fingerprint).toBeTruthy()
    expect(thread.messages[2].status).toBe('complete')
    expect(thread.messages[2].generation).toEqual({ model: chat.model, provider: chat.provider, reasoning: chat.reasoning })
    expect(readProgress(target.courseId).projects[target.moduleId].lastReview?.chatId).toBe(chat.id)
    expect(readProgress(target.courseId).projects[target.moduleId].completedAt).toBeUndefined()
    expect(db().prepare('SELECT COUNT(*) AS n FROM course_project_tool_calls').get()).toMatchObject({ n: 1 })
    expect(sender.send.mock.calls.some(([channel]) => channel === 'projectChat:activity')).toBe(true)
  })
  it('refreshes changed requirements and does not re-send stale file evidence on the next review', async () => {
    openCourseProject(target)
    const chat = createProjectChat(target)
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => { options.onDelta('feedback'); return { text: 'feedback', aborted: false, output: [] } })
    await sendProjectMessage(sender as never, chat.id, 'Clarify this'); await settle()
    const changed = projectCourse(); const mod = changed.modules[1]
    if (mod.type === 'project') mod.project.requirements[0].description = 'NEW REQUIREMENT'
    installCourseFixture(changed, target.courseId)
    sender.send.mockClear()
    await sendProjectMessage(sender as never, chat.id, 'Clarify again'); await settle()
    const thread = getProjectChat(chat.id)
    expect(thread.messages.filter((m) => m.role === 'context')).toHaveLength(2)
    expect(JSON.stringify(mocked.stream.mock.calls.at(-1)![0].input)).toContain('NEW REQUIREMENT')
    expect(JSON.stringify(mocked.stream.mock.calls.at(-1)![0].input)).not.toContain('function_call_output')
  })
  it('returns no-key and busy without making additional billable requests', async () => {
    openCourseProject(target); const chat = createProjectChat(target)
    mocked.key.value = ''
    expect(await sendProjectMessage(sender as never, chat.id, 'hi')).toEqual({ status: 'no-key' })
    expect(mocked.stream).not.toHaveBeenCalled()
    mocked.key.value = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    mocked.stream.mockImplementation(() => new Promise(() => {}))
    await sendProjectMessage(sender as never, chat.id, 'hi')
    expect(await sendProjectMessage(sender as never, chat.id, 'twice')).toEqual({ status: 'busy' })
    cancelProjectChat(chat.id)
  })
  it('keeps partial replies on Stop, failure and renderer loss, scrubbing credentials in errors', async () => {
    openCourseProject(target)
    const chat = createProjectChat(target)
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => { options.onDelta('Partial feedback'); await new Promise((r) => setTimeout(r, 30)); throw new Error('failed sk-proj-abcdefghijklmnopqrstuvwxyz0123456789') })
    await sendProjectMessage(sender as never, chat.id, 'hello'); await new Promise((r) => setTimeout(r, 10)); cancelProjectChat(chat.id)
    expect(getProjectChat(chat.id).messages.at(-1)).toMatchObject({ text: 'Partial feedback', status: 'stopped' })
    expect(getProjectChat(chat.id).messages.at(-1)?.generation).toEqual({ model: chat.model, provider: chat.provider, reasoning: chat.reasoning })
    const next = createProjectChat(target); sender.send.mockClear()
    await sendProjectMessage(sender as never, next.id, 'hello'); await settle()
    expect(getProjectChat(next.id).messages.at(-1)?.status).toBe('failed')
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('sk-proj-')
    const lost = createProjectChat(target); sender.send.mockClear()
    await sendProjectMessage(sender as never, lost.id, 'hello'); await new Promise((r) => setTimeout(r, 10)); sender.emit('destroyed')
    expect(getProjectChat(lost.id).messages.at(-1)?.status).toBe('stopped')
  })
  it('saves before switching users and never executes a late tool against another user', async () => {
    openCourseProject(target); const chat = createProjectChat(target)
    mocked.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('Partial')
      await new Promise((r) => setTimeout(r, 30))
      return { text: 'Partial', aborted: false, output: [{ type: 'function_call', call_id: 'late', name: 'read_project_file', arguments: '{"path":"README.md","start_line":1,"max_lines":100}' }] }
    })
    await sendProjectMessage(sender as never, chat.id, 'hello'); await new Promise((r) => setTimeout(r, 10))
    cancelAllProjectChats(); closeDb()
    const second = createUser('Other learner'); switchUser(second.id)
    expect(selectProjectChat(chat.id)).toBeNull()
    await new Promise((r) => setTimeout(r, 40))
    expect(db().prepare('SELECT COUNT(*) AS n FROM course_project_tool_calls').get()).toMatchObject({ n: 0 })
    closeDb(); switchUser(userId)
    expect(getProjectChat(chat.id).messages.at(-1)).toMatchObject({ text: 'Partial', status: 'stopped' })
  })
  it('keeps project histories separate and deletes chat rows without touching learner files', () => {
    const course = projectCourse(); const another = structuredClone(course.modules[1]); another.slug = 'another-project'; course.modules.push(another)
    installCourseFixture(course, target.courseId)
    openCourseProject(target); const chat = createProjectChat(target)
    const edited = installCourseFixture(course, target.courseId)
    createProjectChat({ ...target, moduleId: edited.modules.at(-1)!.slug })
    expect(listProjectChats(target).map((c) => c.id)).toEqual([chat.id])
    deleteProjectChat(chat.id)
    expect(listProjectChats(target)).toEqual([])
    expect(existsSync(join(courseProjectDir(userId, target.courseId, target.moduleId), 'README.md'))).toBe(true)
  })
  it('adds project tables when upgrading a v4 database without dropping lesson chat data', () => {
    const d = db()
    d.prepare('INSERT INTO chats (id, course_slug, model, module_slug, lesson_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', 'demo', 'gpt-5-mini', 'one', 'intro', 'now', 'now')
    d.exec('DROP TABLE course_project_tool_calls; DROP TABLE course_project_messages; DROP TABLE course_project_chats; PRAGMA user_version = 4')
    closeDb()
    expect(db().prepare('SELECT id FROM chats WHERE id = ?').get('legacy')).toMatchObject({ id: 'legacy' })
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
    expect(createProjectChat(target).moduleId).toBe(target.moduleId)
  })
})
