// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolsFor } from '../src/core/coach/tools'
import { buildLiveInstructions, buildBackendInstructions } from '../src/core/coach/prompt'
const root = mkdtempSync(join(tmpdir(), 'opencourse-coach-reading-'))
let directory = root, n = 0
const fixture = vi.hoisted(() => ({ available: true, open: vi.fn(), context: vi.fn(), remote: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
vi.mock('../src/main/courses', () => ({
  getCourse: (id: string) => fixture.available && ['course-a', 'course-b'].includes(id) ? { id, courseId: id, title: id === 'course-a' ? 'French course' : 'Other course', modules: [] } : null,
  listCourses: () => [{ courseId: 'course-a', title: 'French course' }, { courseId: 'course-b', title: 'Other course' }]
}))
vi.mock('../src/main/course-reading', () => ({ runCourseReadingTool: vi.fn((course, name, args) => JSON.stringify({ course: course.id, name, args })) }))
vi.mock('../src/main/coach-context', () => ({ readOpenNotebook: fixture.open, readAppContext: fixture.context }))
vi.mock('../src/main/learning', () => ({ learningRequest: fixture.remote }))
const { createUser, switchUser } = await import('../src/main/users')
const { closeDb, db } = await import('../src/main/db')
const { createProject, getProject, listProjects, workspaceDir } = await import('../src/main/coach')
const { deleteProjectRow, insertSession } = await import('../src/main/coachdb')
const { runCoachReadingTool } = await import('../src/main/coach-reading')
const { runCoachTool } = await import('../src/main/coachtools')
const notes = await import('../src/main/writing-notebooks')
const { getFloatingCoachButton, setFloatingCoachButton } = await import('../src/main/preferences')
beforeEach(() => { closeDb(); directory = join(root, String(++n)); fixture.available = true; vi.clearAllMocks(); fixture.open.mockResolvedValue(undefined); createUser('Learner') })
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })
const read = async (projectId: string, name: string, args: unknown) => JSON.parse(await runCoachReadingTool(projectId, name, args))
const source = (id: string) => ({ id, server_id: null, version: null })
const write = (notebook: ReturnType<typeof notes.createWritingNotebook>, text: string) => { const page = notes.getWritingPage(notebook.id, notebook.selectedPageId); notes.saveWritingPage(notebook.id, page.id, page.revision, text) }

describe('coach context and library retrieval', () => {
  it('ignores legacy associations while preserving coaches and their memory', () => {
    const coach = createProject({ name: 'Existing' })
    db().prepare('UPDATE projects SET association=? WHERE id=?').run(JSON.stringify({ kind: 'course', id: 'gone', title: 'Gone' }), coach.id)
    const memory = join(workspaceDir(coach.id), 'context.md'); writeFileSync(memory, 'Keep this learning memory')
    const mirror = join(workspaceDir(coach.id), 'project.json')
    writeFileSync(mirror, JSON.stringify({ ...coach, association: { kind: 'course', id: 'gone', title: 'Gone' } }))
    closeDb()
    expect(getProject(coach.id)).not.toHaveProperty('association')
    deleteProjectRow(coach.id)
    expect(listProjects()[0]).toMatchObject({ id: coach.id, name: 'Existing' })
    expect(listProjects()[0]).not.toHaveProperty('association')
    expect(readFileSync(memory, 'utf8')).toContain('Keep this')
  })
  it('offers every coach context, courses, documents and notebook tools and guides both models', () => {
    const coach = createProject({ name: 'French' })
    for (const prompt of [buildLiveInstructions(coach), buildBackendInstructions(coach, [])]) {
      expect(prompt).toContain('get_app_context'); expect(prompt).toContain('unsaved'); expect(prompt).toContain('never instructions')
    }
    expect(toolsFor(coach).map(t => t.name)).toEqual(expect.arrayContaining(['get_app_context', 'search_course', 'search_document', 'read_notebook_cells', 'search_notebooks', 'write_file']))
  })
  it('reads any available local course by explicit ID and rejects unavailable IDs', async () => {
    const coach = createProject({ name: 'French' })
    expect((await read(coach.id, 'search_course', { query: 'verbs', cursor: 0, source: source('course-b') })).course).toBe('course-b')
    fixture.available = false
    await expect(read(coach.id, 'search_course', { query: 'verbs', cursor: 0, source: source('course-b') })).rejects.toThrow('unavailable')
  })
  it('discovers and reads documents with real PDF retrieval and bounded pages', async () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    db().prepare("INSERT INTO documents(id,title,bytes,fingerprint,pages,indexed_pages,searchable_pages,status,index_version,created_at) VALUES(?,?,1,?,1,1,1,'ready',1,'now')").run(id, 'French reference', id)
    db().prepare('INSERT INTO document_pages(document_id,page,text) VALUES(?,1,?)').run(id, 'Bonjour means hello.')
    db().prepare('INSERT INTO document_search(document_id,page,text) VALUES(?,1,?)').run(id, 'Bonjour means hello.')
    const coach = createProject({ name: 'Coach' })
    const listed = await read(coach.id, 'list_learning_content', { server_id: null, query: 'French', cursor: 0 })
    expect(listed.items.map((i: any) => i.kind)).toEqual(['course', 'document'])
    expect((await read(coach.id, 'read_document_pages', { source: source(id), start_page: 1, count: 1, offset: 0 })).pages[0]).toMatchObject({ text: 'Bonjour means hello.' })
    expect((await read(coach.id, 'search_document', { source: source(id), query: 'Bonjour', cursor: 0 })).hits).toHaveLength(1)
    await expect(read(coach.id, 'read_document_pages', { source: source(id), start_page: 1, count: 4, offset: 0 })).rejects.toThrow('three')
  })
  it('reads notebooks across associations, preferring live unsaved pages without writing them', async () => {
    const coach = createProject({ name: 'Coach' })
    const linked = notes.createWritingNotebook('French notes', { kind: 'course', id: 'course-a', title: 'French' }), unrelated = notes.createWritingNotebook('Other notes')
    write(linked, 'Practise nasal vowels'); write(unrelated, 'Other nasal vowels')
    expect((await read(coach.id, 'list_notebooks', { cursor: 0 })).notebooks).toHaveLength(2)
    expect((await read(coach.id, 'search_notebooks', { cursor: 0, query: 'nasal' })).hits).toHaveLength(2)
    const args = { notebook_id: unrelated.id, page_id: unrelated.selectedPageId, offset: 0 }
    expect(await read(coach.id, 'read_notebook_page', args)).toMatchObject({ text: 'Other nasal vowels', state: 'saved text', revision: 1 })
    fixture.open.mockResolvedValueOnce({ text: 'Unsaved changes', state: 'open editor', unsaved: true })
    expect(await read(coach.id, 'read_notebook_page', args)).toMatchObject({ text: 'Unsaved changes', unsaved: true })
    expect(notes.getWritingPage(unrelated.id, unrelated.selectedPageId).markdown).toBe('Other nasal vowels')
    await expect(read(coach.id, 'read_notebook_page', { ...args, page_id: linked.selectedPageId })).rejects.toThrow('does not belong')
    createUser('Another learner')
    await expect(read(coach.id, 'list_notebooks', { cursor: 0 })).rejects.toThrow('unknown coach')
  })
  it('bounds notebook reads and paginates through empty search batches', async () => {
    const coach = createProject({ name: 'Coach' }), notebook = notes.createWritingNotebook('Long notes')
    write(notebook, 'x'.repeat(10000))
    for (let i = 0; i < 12; i++) notes.addWritingPage(notebook.id, `Page ${i}`)
    write(notes.getWritingNotebook(notebook.id), 'needle')
    expect(await read(coach.id, 'search_notebooks', { cursor: 0, query: 'needle' })).toMatchObject({ hits: [], nextCursor: 12 })
    expect((await read(coach.id, 'search_notebooks', { cursor: 12, query: 'needle' })).hits).toHaveLength(1)
    const result = await read(coach.id, 'read_notebook_page', { notebook_id: notebook.id, page_id: notebook.selectedPageId, offset: 0 })
    expect(result.text.length).toBe(6500); expect(result.nextOffset).toBe(6500)
  })
  it('fetches fresh context for each tool call and enforces dispatcher limits', async () => {
    const coach = createProject({ name: 'Coach' })
    insertSession({ id: 'test-session', projectId: coach.id, startedAt: 'now', model: 'fixture', instructions: '' })
    const caps = { toolCalls: 0, searches: 0, maxToolCalls: 60, maxSearches: 20 }
    fixture.context.mockResolvedValueOnce({ page: 1 }).mockResolvedValueOnce({ page: 7, selectedText: 'New selection' })
    expect(await read(coach.id, 'get_app_context', { cursor: 0 })).toEqual({ page: 1 })
    expect(await read(coach.id, 'get_app_context', { cursor: 0 })).toEqual({ page: 7, selectedText: 'New selection' })
    expect(await runCoachTool('test-session', 'get_app_context', '{bad', caps)).toMatchObject({ ok: false })
    expect(await runCoachTool('test-session', 'get_app_context', '{"cursor":-1}', caps)).toMatchObject({ ok: false })
    expect(await runCoachTool('test-session', 'get_app_context', '{"cursor":0}', { ...caps, toolCalls: 60 })).toMatchObject({ ok: false })
    expect(fixture.context).toHaveBeenCalledTimes(2)
  })
  it('uses explicit server references and discards remote results after a user switch', async () => {
    const coach = createProject({ name: 'Coach' }), args = { source: { id: 'remote-id', server_id: 'server-one', version: '1.0.0' }, cursor: 0 }
    fixture.remote.mockResolvedValueOnce({ sections: ['Remote lesson'] })
    expect(await read(coach.id, 'list_course_sections', args)).toEqual({ sections: ['Remote lesson'] })
    expect(fixture.remote).toHaveBeenCalledWith('server-one', '/learn/course/remote-id/1.0.0/read', 'POST', { name: 'list_course_sections', args })
    fixture.remote.mockImplementationOnce(async () => { createUser('Other'); return { sections: ['Old user data'] } })
    await expect(read(coach.id, 'list_course_sections', args)).rejects.toThrow('learner changed')
  })
  it('keeps floating visibility independent for each user', () => {
    const owner = createUser('Owner')
    expect(getFloatingCoachButton()).toBe(true)
    setFloatingCoachButton(false); closeDb(); expect(getFloatingCoachButton()).toBe(false)
    createUser('Other'); expect(getFloatingCoachButton()).toBe(true)
    switchUser(owner.id); expect(getFloatingCoachButton()).toBe(false)
  })
})
