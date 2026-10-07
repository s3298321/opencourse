import { installCourseFixture } from './helpers/course'
/**
 * Asking a question and getting an answer, with OpenAI replaced by a stream we
 * control.
 *
 * The point of doing it this way is that the interesting parts of this feature
 * are all things a live socket will not do on demand: an answer cut off
 * halfway, an error body that quotes the key it rejected, a second send landing
 * while the first is still running, and the moment a chat crosses from one
 * lesson into another. A canned ReadableStream produces every one of them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatQuote, CourseManifest } from '../src/core/types'
import { TITLE_INSTRUCTIONS } from '../src/core/sidechat/title'

const root = mkdtempSync(join(tmpdir(), 'opencourse-sidechat-send-'))
let dataDir = join(root, 'data')

interface Call {
  url: string
  body: string
  auth: string
}
let calls: Call[] = []
const answerCalls = (): Call[] => calls.filter(call => call.url.includes('/responses') && JSON.parse(call.body).input[0]?.content !== TITLE_INSTRUCTIONS)

/** What the next /responses call does. Set per test. */
let stream: { frames?: string[]; status?: number; body?: string; holdMs?: number; incomplete?: boolean } = { frames: [] }
/** Calls that should each get their own answer, in order; `stream` once these run out. */
let queue: (typeof stream)[] = []

/** What /models lists - everything a key reaches, chat or not. */
let modelIds: string[] = []

const encoder = new TextEncoder()

/**
 * A body that honours the abort signal, because that is the whole point of the
 * cancel path: a fake that kept streaming after an abort would test the fake.
 */
function sseBody(frames: readonly string[], holdMs: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let i = 0
  const aborted = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(aborted())
        return
      }
      if (i >= frames.length) {
        controller.close()
        return
      }
      if (holdMs) await new Promise((r) => setTimeout(r, holdMs))
      if (signal?.aborted) {
        controller.error(aborted())
        return
      }
      controller.enqueue(encoder.encode(frames[i] as string))
      i += 1
    }
  })
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false,
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  },
  net: {
    fetch: (
      url: string,
      init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}
    ) => {
      calls.push({ url, body: init.body ?? '', auth: init.headers?.['Authorization'] ?? '' })
      if (url.endsWith('/models')) {
        const listed = JSON.stringify({ data: modelIds.map((id) => ({ id, object: 'model' })) })
        return Promise.resolve({ ok: true, status: 200, body: null, text: () => Promise.resolve(listed) })
      }
      if (init.body && JSON.parse(init.body).input[0]?.content === TITLE_INSTRUCTIONS) {
        return Promise.resolve({ ok: true, status: 200,
          body: sseBody([textFrame('Event Loop Basics'), 'data: {"type":"response.completed"}\n\n'], 0, init.signal), text: () => Promise.resolve('') })
      }
      const plan = queue.shift() ?? stream
      if (plan.status && plan.status >= 300) {
        return Promise.resolve({
          ok: false,
          status: plan.status,
          body: null,
          text: () => Promise.resolve(plan.body ?? '')
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        body: sseBody(plan.incomplete ? plan.frames ?? [] : [...(plan.frames ?? []), 'data: {"type":"response.completed"}\n\n'], plan.holdMs ?? 0, init.signal),
        text: () => Promise.resolve('')
      })
    }
  }
}))

const { createUser, deleteUser, listUsers } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { selectMessages } = await import('../src/main/chatdb')
const { removeCourse } = await import('../src/main/import')
const { setKey } = await import('../src/main/coachkey')
const {
  cancelChat,
  createChat,
  deleteChat,
  getChat,
  getChatModelSettings,
  getChatWebSearch,
  getSourceIcons,
  listChats,
  listPickerModels,
  sendChatMessage,
  setChatModel,
  setChatDefaults,
  setChatReasoning,
  setChatWebSearch,
  setEnabledChatModels
} = await import('../src/main/chat')
const { STREAM_IDLE_MS, silenceBeforeAnswerMs } = await import('../src/main/openai')
const { userPreferencesFile } = await import('../src/main/paths')
const { DEFAULT_CHAT_MODEL } = await import('../src/core/sidechat/models')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const GOOD = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
const accept = async (): Promise<{ ok: true }> => ({ ok: true })

let courseId = ''
const L1 = { moduleId: 'basics', lessonId: 'one' }
const L2 = { moduleId: 'basics', lessonId: 'two' }

/** Records what main pushed, so the test can read the stream the renderer sees. */
interface Pushed {
  channel: string
  chatId: string
  payload: unknown
}
let pushed: Pushed[] = []
/** A stand-in for the one window: enough of a WebContents for chat.ts to bind to. */
function makeSender(id: number): {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, chatId: string, payload: unknown) => void
  once: (event: string, handler: () => void) => void
  on: (event: string, handler: () => void) => void
  removeListener: (event: string, handler: () => void) => void
  gone: () => void
} {
  const listeners: (() => void)[] = []
  return {
    id,
    isDestroyed: () => false,
    send: (channel, chatId, payload) => pushed.push({ channel, chatId, payload }),
    once: (event, handler) => {
      if (event === 'destroyed') listeners.push(handler)
    },
    on: () => undefined,
    removeListener: (event, handler) => {
      if (event === 'destroyed') {
        const index = listeners.indexOf(handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    /** What Electron does when the window closes. */
    gone: () => listeners.forEach((fn) => fn())
  }
}
let sender = makeSender(1)
const asSender = (): never => sender as never

/** Waits until main has finished with this chat, or gives up. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pushed.some((p) => p.channel === 'chat:done' || p.channel === 'chat:error')) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`no chat:done or chat:error arrived; saw ${JSON.stringify(pushed)}`)
}

const deltas = (): string =>
  pushed.filter((p) => p.channel === 'chat:delta').map((p) => String(p.payload)).join('')

function textFrame(text: string, itemId?: string, contentIndex = 0): string {
  return `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    delta: text,
    ...(itemId ? { item_id: itemId, content_index: contentIndex } : {})
  })}\n\n`
}

/** Any other event, in the stream's own framing. */
function frame(event: Record<string, unknown>): string {
  return `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`
}

const COURSE: CourseManifest = {
  schema_version: '1.2',
  slug: 'test-course',
  title: 'A Test Course',
  subject: 'Testing',
  modules: [
    {
      slug: 'basics',
      title: 'Basics',
      lessons: [
        {
          slug: 'one',
          title: 'Lesson One',
          objectives: ['do the first thing'],
          blocks: [
            { type: 'markdown', slug: 'the-first-lesson-is-about-salamanders', content: 'The first lesson is about SALAMANDERS.' },
            {
              type: 'quiz', slug: 'q1',
              id: 'q1',
              kind: 'single',
              question: 'Which is it?',
              options: [
                { id: 'a', text: 'This one', correct: false },
                { id: 'b', text: 'That one', correct: true }
              ],
              explanation: 'THE GIVEAWAY'
            }
          ]
        },
        {
          slug: 'two',
          title: 'Lesson Two',
          blocks: [{ type: 'markdown', slug: 'the-second-lesson-is-about-axolotls', content: 'The second lesson is about AXOLOTLS.' }]
        }
      ]
    }
  ]
}

let n = 0
beforeEach(async () => {
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
  calls = []
  pushed = []
  sender = makeSender(1)
  stream = { frames: [] }
  queue = []
  modelIds = [DEFAULT_CHAT_MODEL, 'gpt-5.1', 'gpt-5-mini', 'gpt-4.1', 'whisper-1', 'text-embedding-3-large']

  createUser('Ada')
  const course = installCourseFixture(COURSE)
  courseId = course.courseId
  Object.assign(L1, { moduleId: course.modules[0].slug, lessonId: course.modules[0].lessons![0].slug })
  Object.assign(L2, { moduleId: course.modules[0].slug, lessonId: course.modules[0].lessons![1].slug })
  await setKey(GOOD, accept)
})

describe('asking a question', () => {
  it('streams the answer back in order and keeps it', async () => {
    stream = { frames: [textFrame('An '), textFrame('event '), textFrame('loop.')] }
    const chat = createChat(courseId, L1)
    const result = await sendChatMessage(asSender(), chat.id, 'what is it?', undefined, L1)
    expect(result).toEqual({ status: 'ok', seq: 1 })
    await settle()

    expect(deltas()).toBe('An event loop.')
    const messages = selectMessages(chat.id)
    expect(messages.map((m) => m.role)).toEqual(['context', 'user', 'assistant'])
    expect(messages[2]!.text).toBe('An event loop.')
    expect(pushed.find(event => event.channel === 'chat:done')).toEqual({ channel: 'chat:done', chatId: chat.id, payload: { stopped: false } })
    expect(messages[2]!.generation).toEqual({ model: chat.model, reasoning: chat.reasoning, provider: 'apiKey' })
  })

  it('gives the model the lesson, without the answers in it', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()

    const sent = calls.find((c) => c.url.includes('/responses'))!.body
    expect(sent).toContain('SALAMANDERS')
    expect(sent).toContain('Which is it?')
    expect(sent).not.toContain('THE GIVEAWAY')
  })

  it('carries the highlighted passage with the question', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'this bit?', { text: 'about SALAMANDERS', from: 'lesson' }, L1)
    await settle()
    expect(selectMessages(chat.id)[1]!.quote).toEqual({ text: 'about SALAMANDERS', from: 'lesson' })
    const body = calls.find((c) => c.url.includes('/responses'))!.body
    expect(body).toContain('this bit?')
    expect(body).toContain('From the lesson')
  })

  it('tells the model a passage from its own answer is from its answer', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'more on that?', { text: 'a loop of tasks', from: 'answer' }, L1)
    await settle()
    expect(selectMessages(chat.id)[1]!.quote).toEqual({ text: 'a loop of tasks', from: 'answer' })
    const body = calls.find((c) => c.url.includes('/responses'))!.body
    expect(body).toContain('From one of your earlier answers')
    expect(body).not.toContain('From the lesson')
  })

  it('does not take the renderer at its word about a quote it cannot read', async () => {
    // It arrives over IPC. A source it does not know is the lesson, which is
    // what a quote always was; a quote that is not one is no quote at all.
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    const forged = { text: 'from nowhere', from: 'system' } as unknown as ChatQuote
    await sendChatMessage(asSender(), chat.id, 'q', forged, L1)
    await settle()
    expect(selectMessages(chat.id)[1]!.quote).toEqual({ text: 'from nowhere', from: 'lesson' })

    stream = { frames: [textFrame('ok')] }
    await sendChatMessage(asSender(), chat.id, 'q again', 'a bare string' as unknown as ChatQuote, L1)
    await settle()
    expect(selectMessages(chat.id).at(-2)!.quote).toBeUndefined()
  })

  it('refuses an empty question without calling OpenAI', async () => {
    const chat = createChat(courseId, L1)
    expect(await sendChatMessage(asSender(), chat.id, '   ', undefined, L1)).toEqual({
      status: 'failed',
      message: 'there is nothing to ask'
    })
    expect(calls).toEqual([])
  })

  it('says so rather than calling OpenAI when no key is stored', async () => {
    const { clearKey } = await import('../src/main/coachkey')
    clearKey()
    const chat = createChat(courseId, L1)
    expect(await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)).toEqual({ status: 'no-key' })
    expect(calls).toEqual([])
  })

  it('refuses a second question while the first is still being answered', async () => {
    stream = { frames: [textFrame('slow'), textFrame(' answer')], holdMs: 20 }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'first', undefined, L1)
    expect(await sendChatMessage(asSender(), chat.id, 'second', undefined, L1)).toEqual({ status: 'busy' })
    await settle()
    // And once it has finished, the chat is free again.
    pushed = []
    stream = { frames: [textFrame('yes')] }
    expect((await sendChatMessage(asSender(), chat.id, 'second', undefined, L1)).status).toBe('ok')
    await settle()
  })
})

describe('when the lesson changes under a chat', () => {
  it('stops a reply when its course is deleted and does not restore its transcript', async () => {
    stream = { frames: [textFrame('partial'), textFrame(' answer')], holdMs: 20 }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'question', undefined, L1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await removeCourse(courseId)
    await settle()
    expect(getChat(chat.id)).toBeNull()
    expect(selectMessages(chat.id)).toEqual([])
    expect(listChats(courseId)).toEqual([])
    expect(pushed.filter(event => event.channel !== 'chat:title').at(-1)?.channel).toBe('chat:done')
  })
  it('sends the new lesson too, and keeps the old one in the conversation', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'about the first', undefined, L1)
    await settle()

    pushed = []
    calls = []
    stream = { frames: [textFrame('ok again')] }
    await sendChatMessage(asSender(), chat.id, 'about the second', undefined, L2)
    await settle()

    const messages = selectMessages(chat.id)
    expect(messages.map((m) => m.role)).toEqual([
      'context',
      'user',
      'assistant',
      'context',
      'user',
      'assistant'
    ])
    const sent = calls.find((c) => c.url.includes('/responses'))!.body
    // Both lessons are in the request: the earlier context is kept, not replaced.
    expect(sent).toContain('AXOLOTLS')
    expect(sent).toContain('SALAMANDERS')
  })

  it('does not send the lesson twice while the learner stays put', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'one', undefined, L1)
    await settle()
    pushed = []
    stream = { frames: [textFrame('ok')] }
    await sendChatMessage(asSender(), chat.id, 'two', undefined, L1)
    await settle()
    expect(selectMessages(chat.id).filter((m) => m.role === 'context')).toHaveLength(1)
  })

  it('refuses a lesson that is not in this chat\'s course', async () => {
    const chat = createChat(courseId, L1)
    const result = await sendChatMessage(asSender(), chat.id, 'q', undefined, {
      moduleId: 'nope',
      lessonId: 'nope'
    })
    expect(result).toEqual({ status: 'failed', message: 'that lesson is not in this course' })
    expect(calls).toEqual([])
  })
})

describe('when it goes wrong', () => {
  it('marks a disconnected lesson reply as failed and retains its partial text', async () => {
    const chat = createChat(courseId, L1)
    stream = { frames: [textFrame('Partial answer')], incomplete: true }
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(pushed.at(-1)?.channel).toBe('chat:error')
    expect(selectMessages(chat.id).at(-1)).toMatchObject({ text: 'Partial answer', status: 'failed' })
  })

  it('keeps what arrived when the learner stops the answer partway', async () => {
    stream = { frames: [textFrame('half an '), textFrame('answer'), textFrame(' and more')], holdMs: 20 }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await new Promise((r) => setTimeout(r, 45))
    cancelChat(chat.id)
    await settle()

    const answer = selectMessages(chat.id).at(-1)!
    expect(answer.role).toBe('assistant')
    expect(answer.text.length).toBeGreaterThan(0)
    expect(answer.text.startsWith('half an')).toBe(true)
    expect(pushed.at(-1)).toEqual({ channel: 'chat:done', chatId: chat.id, payload: { stopped: true } })
  })

  it('never lets the key back out through an error OpenAI quoted it in', async () => {
    stream = {
      status: 401,
      body: JSON.stringify({ error: { message: `Incorrect API key provided: ${GOOD}. Check your key.` } })
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()

    const failure = pushed.find((p) => p.channel === 'chat:error')!
    expect(String(failure.payload)).not.toContain(GOOD)
    expect(String(failure.payload)).not.toContain('sk-')
    expect(String(failure.payload)).toContain('[redacted]')
  })

  it('reports a mid-stream failure instead of pretending the answer ended', async () => {
    stream = {
      frames: [
        textFrame('starting'),
        `data: ${JSON.stringify({ type: 'error', error: { message: 'the model gave up' } })}\n\n`
      ]
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(pushed.find((p) => p.channel === 'chat:error')).toBeTruthy()
    // Still keeps what it did manage to say.
    expect(selectMessages(chat.id).at(-1)!.text).toBe('starting')
  })

  it('skips a frame it cannot parse rather than losing the whole answer', async () => {
    stream = { frames: [textFrame('before '), 'data: {not json at all\n\n', textFrame('after')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(deltas()).toBe('before after')
  })

  it('ignores deltas that are not text, so audio or reasoning never reaches the page', async () => {
    stream = {
      frames: [
        `data: ${JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' })}\n\n`,
        textFrame('the answer')
      ]
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(deltas()).toBe('the answer')
  })

  it('stops billing when the window asking the question goes away', async () => {
    stream = { frames: [textFrame('a long '), textFrame('answer '), textFrame('nobody will read')], holdMs: 20 }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await new Promise((r) => setTimeout(r, 45))
    sender.gone()
    await new Promise((r) => setTimeout(r, 120))
    // Whatever arrived is still kept - it is the request that stops, not the
    // transcript - and the chat is free for the next window to use.
    const answer = selectMessages(chat.id).at(-1)!
    expect(answer.role).toBe('assistant')
    expect(answer.text.startsWith('a long')).toBe(true)
    pushed = []
    stream = { frames: [textFrame('ready again')] }
    expect((await sendChatMessage(asSender(), chat.id, 'again', undefined, L1)).status).toBe('ok')
    await settle()
  })

  it('throws on a chat that does not exist rather than inventing one', async () => {
    await expect(sendChatMessage(asSender(), 'ch_deadbeefdead', 'q', undefined, L1)).rejects.toThrow(
      'that chat does not exist'
    )
  })
})

describe('the chat list', () => {
  it('shows this course\'s chats and never another\'s', async () => {
    const mine = createChat(courseId, L1)
    expect(listChats(courseId).map((c) => c.id)).toEqual([mine.id])
    expect(listChats('some-other-course')).toEqual([])
  })

  it('refuses to start a chat about a course that is not in the library', () => {
    expect(() => createChat('not-imported', L1)).toThrow('That lesson is not in this course.')
  })

  it('refuses a model that is not a chat model', () => {
    const chat = createChat(courseId, L1)
    expect(() => setChatModel(chat.id, 'gpt-realtime-2.1')).toThrow('not a chat model')
    expect(setChatModel(chat.id, 'gpt-5.1').model).toBe('gpt-5.1')
  })

  it('takes the messages with a deleted chat', async () => {
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    deleteChat(chat.id)
    expect(getChat(chat.id)).toBeNull()
    expect(selectMessages(chat.id)).toEqual([])
  })
})

describe('reasoning', () => {
  const sentBody = (): Record<string, unknown> =>
    JSON.parse(answerCalls().at(-1)!.body) as Record<string, unknown>

  it('says nothing about it until a level is chosen, then sends that level', async () => {
    const chat = createChat(courseId, L1)
    expect(chat.reasoning).toBeNull()
    stream = { frames: [textFrame('ok')] }
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    // Absent rather than a default of ours: every model accepts no `reasoning`.
    expect(sentBody()).not.toHaveProperty('reasoning')

    expect(setChatReasoning(chat.id, 'high').reasoning).toBe('high')
    pushed = []
    stream = { frames: [textFrame('ok')] }
    await sendChatMessage(asSender(), chat.id, 'think harder', undefined, L1)
    await settle()
    expect(sentBody()['reasoning']).toEqual({ effort: 'high' })
  })

  it('refuses a level the chat\'s model does not take', () => {
    const chat = setChatModel(createChat(courseId, L1).id, 'gpt-5.1')
    expect(() => setChatReasoning(chat.id, 'minimal')).toThrow('does not take')
    expect(() => setChatReasoning(chat.id, 'ludicrous' as never)).toThrow('does not take')
    const old = setChatModel(chat.id, 'gpt-4.1')
    expect(() => setChatReasoning(old.id, 'low')).toThrow('does not take')
    // The default is always available, whatever the model.
    expect(setChatReasoning(old.id, null).reasoning).toBeNull()
  })

  it('keeps the level across a model change only if the new model takes it', () => {
    const chat = createChat(courseId, L1)
    setChatReasoning(chat.id, 'high')
    expect(setChatModel(chat.id, 'gpt-5.1').reasoning).toBe('high')
    setChatReasoning(chat.id, 'none')
    // gpt-5 took `minimal` where 5.1 takes `none`: carried over, it would 400.
    expect(setChatModel(chat.id, 'gpt-5-mini').reasoning).toBeNull()
  })

  it('waits longer for the first word the harder the model was asked to think', () => {
    expect(silenceBeforeAnswerMs(undefined)).toBe(STREAM_IDLE_MS)
    expect(silenceBeforeAnswerMs('low')).toBe(STREAM_IDLE_MS)
    expect(silenceBeforeAnswerMs('high')).toBeGreaterThan(silenceBeforeAnswerMs('medium'))
    expect(silenceBeforeAnswerMs('xhigh')).toBeGreaterThan(silenceBeforeAnswerMs('high'))
  })
})

describe('which models are offered', () => {
  it('persists model and reasoning defaults for new chats without changing existing chats', async () => {
    const existing = createChat(courseId, L1)
    expect(setChatDefaults({ model: 'gpt-5.1', reasoning: 'high' })).toEqual({ model: 'gpt-5.1', reasoning: 'high' })
    closeDb()
    expect(createChat(courseId, L2)).toMatchObject({ model: 'gpt-5.1', reasoning: 'high' })
    expect(getChat(existing.id)!.chat).toMatchObject({ model: DEFAULT_CHAT_MODEL, reasoning: null })
    expect(createChat(courseId, L1, 'gpt-4.1')).toMatchObject({ model: 'gpt-4.1', reasoning: null })
    expect((await getChatModelSettings()).defaults).toEqual({ model: 'gpt-5.1', reasoning: 'high' })
    expect(setChatDefaults({ model: 'gpt-5.1', reasoning: null }).reasoning).toBeNull()
    expect(createChat(courseId, L1).reasoning).toBeNull()
  })

  it('validates defaults, falls back when a default is disabled, and isolates users', async () => {
    expect(() => setChatDefaults({ model: 'whisper-1', reasoning: null })).toThrow('chat model')
    expect(() => setChatDefaults({ model: 'gpt-4.1', reasoning: 'high' })).toThrow('unavailable')
    setChatDefaults({ model: 'gpt-5.1', reasoning: 'none' })
    setEnabledChatModels(['gpt-5-mini'])
    expect(createChat(courseId, L1)).toMatchObject({ model: 'gpt-5-mini', reasoning: null })
    expect(() => setChatDefaults({ model: 'gpt-5.1', reasoning: null })).toThrow('Enable')
    createUser('Grace')
    expect((await getChatModelSettings()).defaults).toEqual({ model: DEFAULT_CHAT_MODEL, reasoning: null })
  })

  it('sends the saved reasoning default on the first message', async () => {
    setChatDefaults({ model: 'gpt-5.1', reasoning: 'high' })
    const chat = createChat(courseId, L1)
    stream = { frames: [textFrame('ok')] }
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    const body = JSON.parse(calls.find((call) => call.url.includes('/responses'))!.body)
    expect(body).toMatchObject({ model: 'gpt-5.1', reasoning: { effort: 'high' } })
  })
  it('offers every chat model the key reaches until Settings says otherwise', async () => {
    const picker = await listPickerModels()
    expect(picker.models.map((m) => m.id)).toEqual([DEFAULT_CHAT_MODEL, 'gpt-4.1', 'gpt-5-mini', 'gpt-5.1'])
    const settings = await getChatModelSettings()
    expect(settings).toMatchObject({ source: 'api', enabled: null })
    expect(settings.models).toEqual(picker.models)
  })

  it('offers only what Settings left on, and Settings still lists everything', async () => {
    expect(setEnabledChatModels(['gpt-5.1', 'gpt-5-mini'])).toEqual(['gpt-5.1', 'gpt-5-mini'])
    // In the key's order, not the order they were ticked in.
    expect((await listPickerModels()).models.map((m) => m.id)).toEqual(['gpt-5-mini', 'gpt-5.1'])
    const settings = await getChatModelSettings()
    expect(settings.models).toHaveLength(4)
    expect(settings.enabled).toEqual(['gpt-5.1', 'gpt-5-mini'])
  })

  it('starts a new chat on the first model left on once the default is switched off', () => {
    setEnabledChatModels(['gpt-5-mini', 'gpt-5.1'])
    expect(createChat(courseId, L1).model).toBe('gpt-5-mini')
    setEnabledChatModels(['gpt-5.1', DEFAULT_CHAT_MODEL])
    expect(createChat(courseId, L1).model).toBe(DEFAULT_CHAT_MODEL)
  })

  it('will not switch every model off, and goes back to all of them on request', async () => {
    expect(() => setEnabledChatModels([])).toThrow('at least one')
    // Nothing that cannot chat counts towards "at least one".
    expect(() => setEnabledChatModels(['whisper-1'])).toThrow('at least one')
    setEnabledChatModels(['gpt-5.1'])
    expect(setEnabledChatModels(null)).toBeNull()
    expect((await listPickerModels()).models).toHaveLength(4)
    expect(JSON.parse(readFileSync(userPreferencesFile(listUsers()[0]!.id), 'utf8'))).toEqual({})
  })

  it('never offers an empty picker, whatever the file says', async () => {
    // Everything ticked has since gone from the key: an empty dropdown is a
    // dead end, so the whole list comes back.
    setEnabledChatModels(['gpt-5.2'])
    expect((await listPickerModels()).models).toHaveLength(4)
    // And a file a person broke by hand costs the setting, not the chat.
    writeFileSync(userPreferencesFile(listUsers()[0]!.id), '{ "chatModels": ')
    expect((await getChatModelSettings()).enabled).toBeNull()
  })

  it('keeps one person\'s choice to themselves', async () => {
    setEnabledChatModels(['gpt-5.1'])
    createUser('Grace')
    expect((await getChatModelSettings()).enabled).toBeNull()
  })
})

describe('web search', () => {
  const URL_A = 'https://docs.python.org/3/whatsnew/3.14.html?utm_source=openai'
  const URL_B = 'https://peps.python.org/pep-0779/?utm_source=openai'
  const sentBody = (): Record<string, unknown> =>
    JSON.parse(answerCalls().at(-1)!.body) as Record<string, unknown>
  const instructions = (): string => {
    const input = sentBody()['input'] as { role: string; content: string }[]
    return input[0]!.content
  }
  const annotation = (itemId: string, url: string, title: string, start: number, end: number): string =>
    frame({
      type: 'response.output_text.annotation.added',
      item_id: itemId,
      content_index: 0,
      annotation_index: 0,
      annotation: { type: 'url_citation', url, title, start_index: start, end_index: end }
    })
  const searchFrames = (query: string): string[] => [
    frame({ type: 'response.output_item.added', item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
    frame({ type: 'response.web_search_call.in_progress', item_id: 'ws_1' }),
    frame({ type: 'response.web_search_call.searching', item_id: 'ws_1' }),
    frame({ type: 'response.web_search_call.completed', item_id: 'ws_1' }),
    frame({
      type: 'response.output_item.done',
      item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query } }
    })
  ]

  it('is off until Settings turns it on, and the model is told it cannot look things up', async () => {
    expect(getChatWebSearch()).toBe(false)
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(sentBody()).not.toHaveProperty('tools')
    expect(instructions()).toContain('You have no way to look anything up.')
  })

  it('offers the hosted tool once it is on, and tells the model when to use it', async () => {
    expect(setChatWebSearch(true)).toBe(true)
    stream = { frames: [textFrame('ok')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(sentBody()['tools']).toEqual([{ type: 'web_search' }])
    expect(instructions()).toContain('You can search the web')
    // The function-tool settings belong to the project agent, not to this.
    expect(sentBody()).not.toHaveProperty('store')
    expect(sentBody()).not.toHaveProperty('max_output_tokens')
  })

  it('does not offer it to a model that cannot take it', async () => {
    setChatWebSearch(true)
    stream = { frames: [textFrame('ok')] }
    const chat = setChatModel(createChat(courseId, L1).id, 'gpt-4.1-nano')
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(sentBody()).not.toHaveProperty('tools')
    expect(instructions()).toContain('You have no way to look anything up.')
  })

  it('says what it is doing while it searches', async () => {
    setChatWebSearch(true)
    stream = { frames: [...searchFrames('python 3.14 release date'), textFrame('October.')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'when?', undefined, L1)
    await settle()
    const said = pushed.filter((p) => p.channel === 'chat:activity').map((p) => p.payload)
    expect(said[0]).toBe('Searching the web…')
    expect(said.at(-1)).toBe('Searched the web for “python 3.14 release date”')
    expect(deltas()).toBe('October.')
  })

  it('keeps the pages an answer cited, at offsets into the answer as stored', async () => {
    setChatWebSearch(true)
    // Two message parts: the second part's offsets count from its own start,
    // and the stored ones must count from the start of the whole answer.
    const intro = 'Short version first. '
    const body = `It shipped in October 2025 ([docs.python.org](${URL_A})).`
    const link = `([docs.python.org](${URL_A}))`
    stream = {
      frames: [
        textFrame(intro, 'msg_a'),
        ...searchFrames('python 3.14'),
        textFrame(body.slice(0, 20), 'msg_b'),
        textFrame(body.slice(20), 'msg_b'),
        annotation('msg_b', URL_A, "What's new in Python 3.14", body.indexOf(link), body.indexOf(link) + link.length)
      ]
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'when?', undefined, L1)
    await settle()
    const answer = selectMessages(chat.id).at(-1)!
    expect(answer.text).toBe(intro + body)
    expect(answer.citations).toEqual([
      {
        url: URL_A,
        title: "What's new in Python 3.14",
        start: intro.length + body.indexOf(link),
        end: intro.length + body.indexOf(link) + link.length
      }
    ])
    expect(answer.text.slice(answer.citations![0]!.start, answer.citations![0]!.end)).toBe(link)
  })

  it('takes the finished response\'s list over the ones that arrived one at a time', async () => {
    setChatWebSearch(true)
    const text = `A ([a](${URL_A})) and B ([b](${URL_B})).`
    stream = {
      frames: [
        textFrame(text, 'msg_1'),
        annotation('msg_1', URL_A, 'A', 4, 4 + `([a](${URL_A}))`.length),
        frame({
          type: 'response.completed',
          response: {
            output: [
              { id: 'ws_1', type: 'web_search_call' },
              {
                id: 'msg_1',
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text,
                    annotations: [
                      { type: 'url_citation', url: URL_A, title: 'A', start_index: 2, end_index: 2 + `([a](${URL_A}))`.length },
                      { type: 'url_citation', url: URL_B, title: 'B', start_index: text.indexOf('(['), end_index: text.length - 1 }
                    ]
                  }
                ]
              }
            ]
          }
        })
      ]
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(selectMessages(chat.id).at(-1)!.citations!.map((c) => c.title)).toEqual(['A', 'B'])
  })

  it('stores nothing about the web for an answer that did not search', async () => {
    setChatWebSearch(true)
    stream = { frames: [textFrame('From the lesson alone.')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(selectMessages(chat.id).at(-1)!).not.toHaveProperty('citations')
  })

  it('keeps the citations of a stopped answer along with its text', async () => {
    setChatWebSearch(true)
    const said = `Cited ([a](${URL_A})).`
    stream = {
      frames: [textFrame(said, 'msg_1'), annotation('msg_1', URL_A, 'A', 6, said.length - 1), textFrame(' more', 'msg_1'), textFrame(' and more', 'msg_1')],
      holdMs: 20
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await new Promise((r) => setTimeout(r, 55))
    cancelChat(chat.id)
    await settle()
    const answer = selectMessages(chat.id).at(-1)!
    expect(answer.text.startsWith(said)).toBe(true)
    expect(answer.citations?.map((c) => c.url)).toEqual([URL_A])
    expect(pushed.at(-1)).toEqual({ channel: 'chat:done', chatId: chat.id, payload: { stopped: true } })
  })

  it('asks again without the tool when the model refuses it, before a word is written', async () => {
    setChatWebSearch(true)
    queue = [
      {
        status: 400,
        body: JSON.stringify({ error: { message: "Tool 'web_search' is not supported with this model." } })
      }
    ]
    stream = { frames: [textFrame('Answered anyway.')] }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    const sent = answerCalls().map((c) => JSON.parse(c.body) as Record<string, unknown>)
    expect(sent).toHaveLength(2)
    expect(sent[0]!['tools']).toEqual([{ type: 'web_search' }])
    expect(sent[1]).not.toHaveProperty('tools')
    expect(pushed.some((p) => p.channel === 'chat:error')).toBe(false)
    expect(selectMessages(chat.id).at(-1)!.text).toBe('Answered anyway.')
  })

  it('does not retry a 400 that has nothing to do with the tool', async () => {
    setChatWebSearch(true)
    stream = { status: 400, body: JSON.stringify({ error: { message: 'Invalid value for input.' } }) }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    expect(answerCalls()).toHaveLength(1)
    expect(String(pushed.find((p) => p.channel === 'chat:error')!.payload)).toContain('Invalid value')
  })

  it('stores the switch as a yes or as nothing, and reports it to the picker and Settings', async () => {
    const file = userPreferencesFile(listUsers()[0]!.id)
    setEnabledChatModels(['gpt-5.1'])
    expect(setChatWebSearch(true)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ chatModels: ['gpt-5.1'], webSearch: true })
    expect((await listPickerModels()).webSearch).toBe(true)
    expect((await getChatModelSettings()).webSearch).toBe(true)
    expect(setChatWebSearch(false)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ chatModels: ['gpt-5.1'] })
    expect((await listPickerModels()).webSearch).toBe(false)
  })

  it('looks up icons only for the sites a stored answer cited', async () => {
    setChatWebSearch(true)
    const said = `Cited ([a](${URL_A})) and ([b](${URL_B})).`
    stream = {
      frames: [
        textFrame(said, 'msg_1'),
        annotation('msg_1', URL_A, 'A', 6, 6 + `([a](${URL_A}))`.length),
        annotation('msg_1', URL_B, 'B', said.lastIndexOf('(['), said.length - 1)
      ]
    }
    const chat = createChat(courseId, L1)
    await sendChatMessage(asSender(), chat.id, 'q', undefined, L1)
    await settle()
    const seq = selectMessages(chat.id).at(-1)!.seq
    // No network in a test: every icon comes back as a letter tile.
    expect(await getSourceIcons(chat.id, seq)).toEqual({ 'docs.python.org': null, 'peps.python.org': null })
    expect(await getSourceIcons(chat.id, seq - 1)).toEqual({})
    await expect(getSourceIcons('ch_000000000000', seq)).rejects.toThrow('does not exist')
  })
})
