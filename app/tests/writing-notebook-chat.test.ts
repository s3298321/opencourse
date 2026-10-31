// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamOptions } from '../src/main/openai'
const root = mkdtempSync(join(tmpdir(), 'opencourse-writing-chat-'))
let directory = root, n = 0
const ai = vi.hoisted(() => ({ key: 'sk-local-test', stream: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => ai.key }))
vi.mock('../src/main/subscription', () => ({ subscriptionIdentity: () => null, subscriptionAccessToken: vi.fn() }))
vi.mock('../src/main/chattitles', () => ({ cancelChatTitles: vi.fn(), generateChatTitle: vi.fn() }))
vi.mock('../src/main/openai', async original => ({ ...await original<object>(), streamChat: (options: ChatStreamOptions) => ai.stream(options) }))
const { createUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
const chats = await import('../src/main/writing-notebook-chat')
const { selectWritingNotebookMessages } = await import('../src/main/writing-notebook-chatdb')
const { buildInput } = await import('../src/core/sidechat/thread')
beforeEach(() => { chats.cancelAllWritingNotebookChats(); closeDb(); directory = join(root, String(++n)); createUser('Writer'); ai.key = 'sk-local-test'; ai.stream.mockReset().mockResolvedValue({ text: 'An explanation', aborted: false, citations: [], output: [] }) })
afterAll(() => { chats.cancelAllWritingNotebookChats(); closeDb(); rmSync(root, { recursive: true, force: true }) })
function sender() { return Object.assign(new EventEmitter(), { id: n, isDestroyed: () => false, send: vi.fn() }) }
const done = async (window: ReturnType<typeof sender>, id: string) => vi.waitFor(() => expect(window.send).toHaveBeenCalledWith('writingChat:done', id, { stopped: false }))
describe('writing notebook chat', () => {
  it('continues the same chat across pages with saved revision context and notebook-specific quotes', async () => {
    const notebook = notes.createWritingNotebook('Learning'), first = notebook.selectedPageId
    notes.saveWritingPage(notebook.id, first, 0, '# First\nA saved idea')
    const conversation = chats.createWritingNotebookChat(notebook.id, first), window = sender()
    expect(await chats.sendWritingNotebookMessage(window as never, conversation.id, 'Explain', { text: 'saved idea', from: 'writing-notebook', writingNotebook: { notebookId: notebook.id, pageId: first, revision: 1, title: 'Untrusted' } }, first)).toMatchObject({ status: 'ok' })
    await done(window, conversation.id)
    let messages = selectWritingNotebookMessages(conversation.id)
    expect(messages[0]).toMatchObject({ role: 'context', writingNotebook: { pageId: first, revision: 1, title: 'Untitled page' } })
    expect(messages[1]?.quote?.from).toBe('writing-notebook')
    const second = notes.addWritingPage(notebook.id, 'Second page').selectedPageId
    notes.saveWritingPage(notebook.id, second, 0, 'Second idea')
    window.send.mockClear()
    await chats.sendWritingNotebookMessage(window as never, conversation.id, 'Compare these pages', undefined, second)
    await done(window, conversation.id)
    messages = selectWritingNotebookMessages(conversation.id)
    expect(messages.filter(m => m.role === 'context').map(m => m.writingNotebook?.pageId)).toEqual([first, second])
    const input = JSON.stringify(buildInput(messages, 'test'))
    expect(input).toContain('Earlier notebook page'); expect(input).toContain('Second idea'); expect(chats.listWritingNotebookChats(notebook.id)).toHaveLength(1)
  })
  it('refreshes context after edits and ignores foreign page quotes', async () => {
    const notebook = notes.createWritingNotebook('N'), page = notebook.selectedPageId, conversation = chats.createWritingNotebookChat(notebook.id, page), window = sender()
    await chats.sendWritingNotebookMessage(window as never, conversation.id, 'One', undefined, page); await done(window, conversation.id)
    notes.saveWritingPage(notebook.id, page, 0, 'Updated saved text'); window.send.mockClear()
    await chats.sendWritingNotebookMessage(window as never, conversation.id, 'Two', { text: 'foreign', from: 'writing-notebook', writingNotebook: { notebookId: 'other', pageId: page, revision: 0, title: 'Foreign' } }, page); await done(window, conversation.id)
    const messages = selectWritingNotebookMessages(conversation.id)
    expect(messages.filter(m => m.role === 'context').map(m => m.writingNotebook?.revision)).toEqual([0, 1])
    expect(messages.filter(m => m.role === 'user').at(-1)?.quote).toBeUndefined()
  })
  it('requires a connection before storing messages and rejects unrelated pages', async () => {
    const notebook = notes.createWritingNotebook('N'), other = notes.createWritingNotebook('Other'), chat = chats.createWritingNotebookChat(notebook.id, notebook.selectedPageId), window = sender()
    ai.key = ''
    expect(await chats.sendWritingNotebookMessage(window as never, chat.id, 'Ask', undefined, notebook.selectedPageId)).toMatchObject({ status: 'connection-required' })
    expect(selectWritingNotebookMessages(chat.id)).toEqual([])
    await expect(chats.sendWritingNotebookMessage(window as never, chat.id, 'Ask', undefined, other.selectedPageId)).rejects.toThrow('page no longer exists')
  })
  it('reads only the associated coach brief, notes, and saved transcripts', async () => {
    const { createProject, deleteProject } = await import('../src/main/coach')
    const { writeWorkspaceFile } = await import('../src/main/coachfiles')
    const { insertSession, saveTurns } = await import('../src/main/coachdb')
    const { runWritingReadingTool, notebookSnapshot } = await import('../src/main/writing-notebook-reading')
    const project = createProject({ name: 'Language coach', instructions: 'Practise French pronunciation.' })
    const foreign = createProject({ name: 'Other coach' })
    writeWorkspaceFile(project.id, 'notes.md', 'Practise nasal vowels.')
    writeWorkspaceFile(foreign.id, 'private.md', 'Unrelated private material')
    insertSession({ id: 'session-fixture', projectId: project.id, startedAt: new Date().toISOString(), model: 'fixture', instructions: 'fixture' })
    saveTurns('session-fixture', [{ seq: 0, role: 'user', text: 'Please explain liaison.', at: new Date().toISOString() }])
    const notebook = notes.createWritingNotebook('French', { kind: 'coach', id: project.id, title: 'ignored' })
    const budget = { chars: 0, signal: new AbortController().signal }, sources: import('../src/core/types').ReadingSource[] = []
    const read = (id: string) => JSON.parse(runWritingReadingTool(notebook, notebookSnapshot(notebook), 'read_coach_material', { id, offset: 0 }, budget, sources))
    expect(read('instructions').text).toContain('French pronunciation')
    expect(read('file:notes.md').text).toContain('nasal vowels')
    expect(read('session:session-fixture').text).toContain('liaison')
    expect(() => read('file:private.md')).toThrow('not in the associated coach')
    expect(sources.every(source => source.kind === 'coach' && source.projectId === project.id)).toBe(true)
    deleteProject(project.id)
    expect(() => read('instructions')).toThrow('unavailable')
    expect(notes.getWritingNotebook(notebook.id).associationAvailable).toBe(false)
  })
  it('preserves partial responses and prevents duplicate sends when the window disappears', async () => {
    const notebook = notes.createWritingNotebook('N'), chat = chats.createWritingNotebookChat(notebook.id, notebook.selectedPageId), window = sender()
    ai.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('Partial answer')
      await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { text: 'Partial answer', aborted: true, citations: [], output: [] }
    })
    await chats.sendWritingNotebookMessage(window as never, chat.id, 'Ask', undefined, notebook.selectedPageId)
    await vi.waitFor(() => expect(ai.stream).toHaveBeenCalledOnce())
    expect(await chats.sendWritingNotebookMessage(window as never, chat.id, 'Duplicate', undefined, notebook.selectedPageId)).toEqual({ status: 'busy' })
    window.emit('destroyed')
    expect(selectWritingNotebookMessages(chat.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Partial answer', status: 'stopped' })
    notes.deleteWritingNotebook(notebook.id)
    expect(selectWritingNotebookMessages(chat.id)).toEqual([])
  })
})
