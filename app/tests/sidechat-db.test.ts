/**
 * Side chat's rows, against real files.
 *
 * The chat tables were added to a database that already had coach transcripts
 * in it, so the first thing checked here is that a v1 file survives meeting the
 * v2 code. After that it is the two boundaries the feature promises: a chat
 * belongs to one course, and one user never sees another's.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-sidechat-db-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  }
}))

const { newChatId } = await import('../src/core/sidechat/ids')
const { newSessionId } = await import('../src/core/coach/ids')
const { createUser, deleteUser, listUsers, switchUser } = await import('../src/main/users')
const { userDbFile } = await import('../src/main/paths')
const { SCHEMA_VERSION, closeDb, db } = await import('../src/main/db')
const { insertSession, saveTurns, selectTurns } = await import('../src/main/coachdb')
const { createProject, listProjects } = await import('../src/main/coach')
const {
  appendMessage,
  deleteChatRow,
  insertChat,
  selectChat,
  selectChats,
  selectMessageCitations,
  selectMessages,
  updateChatModel,
  updateChatReasoning
} = await import('../src/main/chatdb')
const { insertProjectChat, selectProjectChat, appendProjectMessage, selectProjectMessages } = await import('../src/main/projectchatdb')

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
beforeEach(() => {
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
})

const AT = '2026-09-14T10:00:00.000Z'
const LESSON = { moduleId: 'foundations', lessonId: 'event-loop' }

function startChat(courseId = 'python-asyncio', lesson = LESSON): string {
  const id = newChatId()
  insertChat({ id, courseId, model: 'gpt-5.6-terra', startedIn: lesson, at: AT })
  return id
}

describe('the v9 message-generation migration', () => {
  it('preserves old timestamps without attributing old answers to today’s model, and persists metadata for new responses', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'assistant', text: 'Old answer', status: 'complete', at: AT })
    db().exec('ALTER TABLE chat_messages DROP COLUMN generation; PRAGMA user_version = 8')
    closeDb()
    expect(selectMessages(id)[0]).toMatchObject({ text: 'Old answer', at: AT })
    expect(selectMessages(id)[0].generation).toBeUndefined()
    const generation = { model: 'gpt-6.1-sol', reasoning: 'high' as const, provider: 'apiKey' as const }
    appendMessage(id, { role: 'assistant', text: 'New answer', generation, at: AT })
    updateChatModel(id, 'gpt-4.1', null, 'chatgpt')
    closeDb()
    expect(selectMessages(id)[1].generation).toEqual(generation)
    db().prepare('UPDATE chat_messages SET generation = ? WHERE chat_id = ? AND seq = ?').run('{broken', id, 1)
    expect(selectMessages(id)[1]).toMatchObject({ text: 'New answer', at: AT })
    expect(selectMessages(id)[1].generation).toBeUndefined()
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
})

describe('the v8 generated-title migration', () => {
  it('preserves existing lesson and project prompt titles and transcripts, then persists generated names across opens', () => {
    createUser('Ada')
    const lessonId = startChat()
    appendMessage(lessonId, { role: 'user', text: 'How do callbacks work?', at: AT })
    const projectId = newChatId()
    insertProjectChat({ id: projectId, courseId: 'example', moduleId: 'project', model: 'gpt-5.1', reasoning: null, createdAt: AT, updatedAt: AT })
    appendProjectMessage(projectId, { role: 'user', text: 'Review my design', at: AT })
    db().exec('ALTER TABLE chats DROP COLUMN generated_title; ALTER TABLE course_project_chats DROP COLUMN generated_title; PRAGMA user_version = 7')
    closeDb()
    expect(selectChat(lessonId)?.title).toBe('How do callbacks work?')
    expect(selectProjectChat(projectId)?.title).toBe('Review my design')
    expect(selectMessages(lessonId)[0].text).toBe('How do callbacks work?')
    expect(selectProjectMessages(projectId)[0].text).toBe('Review my design')
    db().prepare('UPDATE chats SET generated_title = ? WHERE id = ?').run('Understanding Callbacks', lessonId)
    db().prepare('UPDATE course_project_chats SET generated_title = ? WHERE id = ?').run('Project Design Review', projectId)
    closeDb()
    expect(selectChat(lessonId)).toMatchObject({ title: 'Understanding Callbacks', updatedAt: AT, messages: 1 })
    expect(selectProjectChat(projectId)).toMatchObject({ title: 'Project Design Review', updatedAt: AT, messages: 1 })
    expect(db().prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
  })
})

describe('the v7 provider migration', () => {
  it('binds existing lesson and project selections to API key and preserves history across repeated opens', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'assistant', text: 'Old lesson answer', lesson: LESSON, at: AT })
    const projectId = newChatId()
    insertProjectChat({ id: projectId, courseId: 'example', moduleId: 'project', model: 'gpt-5.1', reasoning: 'high', createdAt: AT, updatedAt: AT })
    appendProjectMessage(projectId, { role: 'assistant', text: 'Old review', status: 'complete', at: AT })
    db().exec('ALTER TABLE chats DROP COLUMN provider')
    db().exec('ALTER TABLE course_project_chats DROP COLUMN provider')
    db().exec('ALTER TABLE chat_messages DROP COLUMN status')
    db().exec('PRAGMA user_version = 6')
    closeDb()
    expect(selectChat(id)).toMatchObject({ provider: 'apiKey', model: 'gpt-5.6-terra', reasoning: null })
    expect(selectProjectChat(projectId)).toMatchObject({ provider: 'apiKey', model: 'gpt-5.1', reasoning: 'high' })
    expect(selectMessages(id)[0]).toMatchObject({ text: 'Old lesson answer' })
    expect(selectMessages(id)[0].status).toBeUndefined() // Legacy completed answers have no status marker.
    expect(selectProjectMessages(projectId)[0].text).toBe('Old review')
    closeDb()
    expect(selectChat(id)?.provider).toBe('apiKey')
    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  })
})

describe('the v2 migration', () => {
  it('adds the chat tables to a database that already holds coach transcripts', () => {
    createUser('Ada')
    // A v1 database, written by the v1 code path and then dropped back to
    // version 1 so the next open has to migrate it for real.
    const project = createProject({ name: 'French' })
    const sessionId = newSessionId()
    insertSession({ id: sessionId, projectId: project.id, startedAt: AT, model: 'gpt-realtime-2.1', instructions: 'x' })
    saveTurns(sessionId, [{ seq: 0, role: 'user', text: 'bonjour', at: AT }])
    db().exec('DROP TABLE chat_messages')
    db().exec('DROP TABLE chats')
    db().exec('PRAGMA user_version = 1')
    closeDb()

    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['chats', 'chat_messages']))
    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)

    // And nothing of the coach's was lost on the way through.
    expect(listProjects().map((p) => p.id)).toEqual([project.id])
    expect(selectTurns(sessionId).map((t) => t.text)).toEqual(['bonjour'])
  })
})

describe('the v3 migration', () => {
  it('reads every quote written before it as a quote from the lesson', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'user', text: 'this bit?', quote: { text: 'await yields', from: 'lesson' }, lesson: LESSON, at: AT })
    // Back to the v2 shape, with the row a v2 build would have written.
    db().exec('ALTER TABLE chat_messages DROP COLUMN quote_from')
    db().exec('PRAGMA user_version = 2')
    closeDb()

    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(selectMessages(id)[0]!.quote).toEqual({ text: 'await yields', from: 'lesson' })
  })

  it('survives a launch killed between adding the column and recording that it did', () => {
    // An ALTER is not idempotent. Re-running it would fail the open, and a
    // failed open quarantines the file - every chat in it - for a column it
    // already has.
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'user', text: 'keep me', lesson: LESSON, at: AT })
    db().exec('PRAGMA user_version = 2')
    closeDb()

    expect(selectMessages(id).map((m) => m.text)).toEqual(['keep me'])
    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  })
})

describe('the v4 migration', () => {
  it('gives every chat written before it the model\'s own reasoning default', () => {
    createUser('Ada')
    const id = startChat()
    db().exec('ALTER TABLE chats DROP COLUMN reasoning')
    db().exec('PRAGMA user_version = 3')
    closeDb()

    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(selectChat(id)!.reasoning).toBeNull()
  })
})

describe('the v6 migration', () => {
  it('reads every answer written before it as one that did not use the web', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'assistant', text: 'from before search', lesson: LESSON, at: AT })
    db().exec('ALTER TABLE chat_messages DROP COLUMN sources')
    db().exec('PRAGMA user_version = 5')
    closeDb()

    expect((db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    const [answer] = selectMessages(id)
    expect(answer!.text).toBe('from before search')
    expect(answer).not.toHaveProperty('citations')
  })
})

describe('a chat', () => {
  it('keeps the pages an answer cited, and nothing for one that cited none', () => {
    createUser('Ada')
    const id = startChat()
    const citations = [
      { url: 'https://docs.python.org/3/?utm_source=openai', title: 'Docs', start: 3, end: 40 },
      { url: 'https://peps.python.org/pep-0008/', title: '', start: -1, end: -1 }
    ]
    const cited = appendMessage(id, { role: 'assistant', text: 'an answer with sources', citations, lesson: LESSON, at: AT })
    appendMessage(id, { role: 'assistant', text: 'one without', citations: [], lesson: LESSON, at: AT })
    const [first, second] = selectMessages(id)
    expect(first!.citations).toEqual(citations)
    expect(second).not.toHaveProperty('citations')
    expect(selectMessageCitations(id, cited)).toEqual(citations)
    expect(selectMessageCitations(id, 99)).toEqual([])
  })

  it('reads a sources column it cannot parse as no sources, and keeps the answer', () => {
    createUser('Ada')
    const id = startChat()
    const seq = appendMessage(id, { role: 'assistant', text: 'still here', lesson: LESSON, at: AT })
    db().prepare('UPDATE chat_messages SET sources = ? WHERE chat_id = ? AND seq = ?').run('[{"url": "javascript:x"}, {', id, seq)
    expect(selectMessages(id)[0]).toMatchObject({ text: 'still here' })
    expect(selectMessages(id)[0]).not.toHaveProperty('citations')
    db().prepare('UPDATE chat_messages SET sources = ? WHERE chat_id = ? AND seq = ?').run('[{"url": "javascript:x"}]', id, seq)
    expect(selectMessages(id)[0]).not.toHaveProperty('citations')
  })

  it('is named by the first thing the learner asked, not by anything stored', () => {
    createUser('Ada')
    const id = startChat()
    expect(selectChat(id)!.title).toBe('')
    appendMessage(id, { role: 'context', text: 'the lesson', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'user', text: 'what is an event loop?', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'assistant', text: 'it is a loop', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'user', text: 'a later question', lesson: LESSON, at: AT })
    expect(selectChat(id)!.title).toBe('what is an event loop?')
  })

  it('counts what was said, and does not count the lesson the app injected', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'context', text: 'the lesson', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'user', text: 'q', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'assistant', text: 'a', lesson: LESSON, at: AT })
    expect(selectChat(id)!.messages).toBe(2)
  })

  it('numbers its messages densely and in order, whatever else is going on', () => {
    createUser('Ada')
    const a = startChat()
    const b = startChat()
    expect(appendMessage(a, { role: 'user', text: 'one', lesson: LESSON, at: AT })).toBe(0)
    expect(appendMessage(b, { role: 'user', text: 'other chat', lesson: LESSON, at: AT })).toBe(0)
    expect(appendMessage(a, { role: 'assistant', text: 'two', lesson: LESSON, at: AT })).toBe(1)
    expect(selectMessages(a).map((m) => m.seq)).toEqual([0, 1])
  })

  it('remembers the quote and the lesson a question was asked from', () => {
    createUser('Ada')
    const id = startChat()
    const other = { moduleId: 'foundations', lessonId: 'coroutines-and-tasks' }
    appendMessage(id, { role: 'user', text: 'this bit?', quote: { text: 'await yields', from: 'lesson' }, lesson: other, at: AT })
    const [message] = selectMessages(id)
    expect(message!.quote).toEqual({ text: 'await yields', from: 'lesson' })
    expect(message!.lesson).toEqual(other)
  })

  it('remembers that a quote was taken from an answer', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'assistant', text: 'it yields to the loop', lesson: LESSON, at: AT })
    appendMessage(id, { role: 'user', text: 'yields?', quote: { text: 'yields to the loop', from: 'answer' }, lesson: LESSON, at: AT })
    expect(selectMessages(id)[1]!.quote).toEqual({ text: 'yields to the loop', from: 'answer' })
  })

  it('rises to the top of the list when something is said in it', () => {
    createUser('Ada')
    const older = startChat()
    const newer = startChat()
    appendMessage(newer, { role: 'user', text: 'second', lesson: LESSON, at: '2026-09-15T10:00:00.000Z' })
    expect(selectChats('python-asyncio').map((c) => c.id)).toEqual([newer, older])
    appendMessage(older, { role: 'user', text: 'first, but asked again', lesson: LESSON, at: '2026-09-16T10:00:00.000Z' })
    expect(selectChats('python-asyncio').map((c) => c.id)).toEqual([older, newer])
  })

  it('orders two chats from the same millisecond the same way twice', () => {
    createUser('Ada')
    startChat()
    startChat()
    startChat()
    const once = selectChats('python-asyncio').map((c) => c.id)
    expect(selectChats('python-asyncio').map((c) => c.id)).toEqual(once)
  })

  it('can be moved to another model', () => {
    createUser('Ada')
    const id = startChat()
    updateChatModel(id, 'gpt-5.1', null)
    expect(selectChat(id)!.model).toBe('gpt-5.1')
  })

  it('starts on the model\'s own reasoning default, and keeps a level once one is set', () => {
    createUser('Ada')
    const id = startChat()
    expect(selectChat(id)!.reasoning).toBeNull()
    updateChatReasoning(id, 'high')
    expect(selectChat(id)!.reasoning).toBe('high')
    updateChatModel(id, 'gpt-5.1', 'low')
    expect(selectChat(id)).toMatchObject({ model: 'gpt-5.1', reasoning: 'low' })
  })

  it('reads a level it does not recognise as the default rather than sending it', () => {
    createUser('Ada')
    const id = startChat()
    db().prepare('UPDATE chats SET reasoning = ? WHERE id = ?').run('ludicrous', id)
    expect(selectChat(id)!.reasoning).toBeNull()
  })

  it('takes its messages with it when deleted', () => {
    createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'user', text: 'q', lesson: LESSON, at: AT })
    deleteChatRow(id)
    expect(selectChat(id)).toBeNull()
    expect(selectMessages(id)).toEqual([])
  })

  it('cannot have a message without a chat to belong to', () => {
    createUser('Ada')
    expect(() =>
      appendMessage('ch_deadbeefdead', { role: 'user', text: 'q', lesson: LESSON, at: AT })
    ).toThrow()
  })
})

describe('the two boundaries', () => {
  it('keeps one course out of another course\'s history', () => {
    createUser('Ada')
    const asyncio = startChat('python-asyncio')
    const c = startChat('intro-to-c', { moduleId: 'basics', lessonId: 'hello' })
    expect(selectChats('python-asyncio').map((x) => x.id)).toEqual([asyncio])
    expect(selectChats('intro-to-c').map((x) => x.id)).toEqual([c])
    expect(selectChats('a-course-nobody-has')).toEqual([])
  })

  it('keeps one user out of another user\'s chats, because the file itself is theirs', () => {
    const ada = createUser('Ada')
    const adaChat = startChat()
    appendMessage(adaChat, { role: 'user', text: 'ada asked this', lesson: LESSON, at: AT })

    const bob = createUser('Bob')
    expect(userDbFile(ada.id)).not.toBe(userDbFile(bob.id))
    expect(selectChats('python-asyncio')).toEqual([])
    const bobChat = startChat()
    appendMessage(bobChat, { role: 'user', text: 'bob asked this', lesson: LESSON, at: AT })
    expect(selectChats('python-asyncio').map((c) => c.title)).toEqual(['bob asked this'])

    switchUser(ada.id)
    expect(selectChats('python-asyncio').map((c) => c.title)).toEqual(['ada asked this'])
  })

  it('takes the chats with a deleted user', () => {
    const ada = createUser('Ada')
    const id = startChat()
    appendMessage(id, { role: 'user', text: 'q', lesson: LESSON, at: AT })
    expect(existsSync(userDbFile(ada.id))).toBe(true)
    closeDb()
    deleteUser(ada.id)
    expect(existsSync(userDbFile(ada.id))).toBe(false)
  })
})
