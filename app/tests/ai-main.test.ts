import { installCourseFixture } from './helpers/course'
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamOptions } from '../src/main/openai'
import { TITLE_INSTRUCTIONS } from '../src/core/sidechat/title'
import { projectCourse } from './helpers/project'
const root = mkdtempSync(join(tmpdir(), 'opencourse-ai-main-'))
let dataDir = root
const mock = vi.hoisted(() => ({ key: 'sk-test-api', account: 'one', ready: true, fetch: vi.fn(), stream: vi.fn(), title: vi.fn(), token: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => dataDir, on: vi.fn() }, net: { fetch: mock.fetch }, shell: {}, dialog: {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: vi.fn() }))
vi.mock('../src/main/coachkey', () => ({ readKey: () => mock.key }))
vi.mock('../src/main/subscription', () => ({
  subscriptionIdentity: () => ({ id: mock.account, label: mock.account, ready: mock.ready, volatile: false }),
  subscriptionAccessToken: () => mock.token()
}))
vi.mock('../src/main/openai', async importOriginal => ({ ...await importOriginal<object>(), streamChat: (options: ChatStreamOptions) => {
  const first = options.input[0]
  return first && 'content' in first && first.content === TITLE_INSTRUCTIONS ? mock.title(options) : mock.stream(options)
} }))
const { createUser, switchUser } = await import('../src/main/users')
const { readPreferences, writePreferences } = await import('../src/main/preferences')
const { closeDb } = await import('../src/main/db')
const ai = await import('../src/main/ai')
const chat = await import('../src/main/chat')
const project = await import('../src/main/projectchat')
const authoringChats = await import('../src/main/authoring-chat')
const authoring = await import('../src/main/course-authoring')
const { openCourseProject } = await import('../src/main/courseprojects')
const target = { courseId: 'projects-demo', moduleId: 'portfolio-project' }
const lesson = { moduleId: 'before', lessonId: 'intro' }
let counter = 0
let owner = ''
let sender: EventEmitter & { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
const profile = (model: string, reasoning: 'high' | 'low' | null = null) => ({ enabledModels: [model], defaultModel: model, defaultReasoning: reasoning })
beforeEach(() => {
  chat.cancelAllChats(); project.cancelAllProjectChats(); authoringChats.cancelAllAuthoringChats(); closeDb()
  dataDir = join(root, String(++counter)); owner = createUser('Learner').id
  const course = installCourseFixture(projectCourse())
  Object.assign(target, { courseId: course.courseId, moduleId: course.modules[1].slug })
  Object.assign(lesson, { moduleId: course.modules[0].slug, lessonId: course.modules[0].lessons![0].slug })
  openCourseProject(target)
  mock.key = 'sk-test-api'; mock.account = 'one'; mock.ready = true
  mock.token.mockReset().mockResolvedValue('subscription-token-one')
  mock.fetch.mockReset().mockImplementation(async (_url, options) => ({ ok: true, text: async () => JSON.stringify(options.headers.Authorization.startsWith('Bearer sk-')
    ? { data: [{ id: 'gpt-5.1' }, { id: 'gpt-4.1' }] }
    : { models: [{ slug: mock.account === 'one' ? 'gpt-5.3-codex' : 'gpt-6.1-sol', display_name: 'Subscription model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] }) }))
  mock.stream.mockReset().mockResolvedValue({ text: 'Answer', aborted: false, citations: [], output: [] })
  mock.title.mockReset().mockResolvedValue({ text: 'Conversation Overview', aborted: false, citations: [], output: [] })
  sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
})
afterAll(() => { chat.cancelAllChats(); project.cancelAllProjectChats(); authoringChats.cancelAllAuthoringChats(); closeDb(); rmSync(root, { recursive: true, force: true }) })
async function settled(channel: string) {
  await vi.waitFor(() => expect(sender.send.mock.calls.some(([name]) => name === channel)).toBe(true))
}
describe('independent main-process AI routing', () => {
  it('loads validated context metadata from the on-disk catalog when offline', async () => {
    const directory = join(dataDir, 'users', owner, 'connections', 'models')
    mkdirSync(directory, { recursive: true })
    const hash = createHash('sha256').update(`${owner}:chatgpt:one`).digest('hex')
    writeFileSync(join(directory, `${hash}.json`), JSON.stringify({ models: [{ id: 'gpt-6.1-sol', label: 'Sol',
      contextWindow: 272_000, maxContextWindow: 872_000, autoCompactTokenLimit: 200_000 }] }))
    mock.fetch.mockRejectedValue(new Error('offline'))
    const catalog = await ai.getAIModelSettings('project', 'chatgpt')
    expect(catalog.source).toBe('cache')
    expect(ai.conversationModelContext('chatgpt', 'gpt-6.1-sol')).toEqual({ contextWindow: 272_000, maxContextWindow: 872_000, autoCompactTokenLimit: 200_000 })
    expect(ai.conversationModelContext('apiKey', 'gpt-6.1-sol')).toEqual({})
  })
  it.each(['project', 'authoring'] as const)('snapshots catalog context for every %s round and refreshes it on the next message', async scope => {
    let metadata = { context_window: 272_000, max_context_window: 872_000, auto_compact_token_limit: 200_000 }
    mock.fetch.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ models: [{ slug: 'gpt-6.1-sol',
      visibility: 'list', display_name: 'Sol', supported_reasoning_levels: ['low'], ...metadata }] }) }))
    await ai.getAIModelSettings(scope, 'chatgpt')
    ai.setAIProvider(scope, 'chatgpt')
    const courseId = scope === 'authoring' ? authoring.createCourse().document.courseId : target.courseId
    const c = scope === 'authoring' ? authoringChats.createAuthoringChat(courseId) : project.createProjectChat(target)
    const send = () => scope === 'authoring'
      ? authoringChats.sendAuthoringMessage(sender as never, c.id, 'Continue', { kind: 'overview' }, 0, 0)
      : project.sendProjectMessage(sender as never, c.id, 'Continue')
    let release!: (result: unknown) => void
    mock.stream.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await expect(send()).resolves.toMatchObject({ status: 'ok' })
    await vi.waitFor(() => expect(mock.stream).toHaveBeenCalledOnce())
    metadata = { context_window: 100_000, max_context_window: 872_000, auto_compact_token_limit: 80_000 }
    await ai.getAIModelSettings(scope, 'chatgpt', true)
    release({ text: '', aborted: false, output: [{ type: 'function_call', call_id: 'read',
      name: scope === 'authoring' ? 'list_attachments' : 'read_project_file',
      arguments: scope === 'authoring' ? '{}' : '{"path":"README.md","start_line":1,"max_lines":5}' }] })
    const channel = scope === 'authoring' ? 'authoringChat:done' : 'projectChat:done'
    await settled(channel)
    expect(mock.stream).toHaveBeenCalledTimes(2)
    for (const [options] of mock.stream.mock.calls) expect(options.modelContext).toEqual({ contextWindow: 272_000, maxContextWindow: 872_000, autoCompactTokenLimit: 200_000 })
    sender.send.mockClear()
    await expect(send()).resolves.toMatchObject({ status: 'ok' }); await settled(channel)
    expect(mock.stream.mock.calls[2][0].modelContext).toEqual({ contextWindow: 100_000, maxContextWindow: 872_000, autoCompactTokenLimit: 80_000 })
  })
  const titleCases = [
    { scope: 'chat', provider: 'apiKey' }, { scope: 'chat', provider: 'chatgpt' },
    { scope: 'project', provider: 'apiKey' }, { scope: 'project', provider: 'chatgpt' }
  ] as const
  function titleChat(scope: 'chat' | 'project') {
    const created = scope === 'chat' ? chat.createChat(target.courseId, lesson) : project.createProjectChat(target)
    return {
      id: created.id,
      get: () => scope === 'chat' ? chat.getChat(created.id)! : project.getProjectChat(created.id),
      list: () => scope === 'chat' ? chat.listChats(target.courseId) : project.listProjectChats(target),
      send: (text: string) => scope === 'chat' ? chat.sendChatMessage(sender as never, created.id, text, undefined, lesson) : project.sendProjectMessage(sender as never, created.id, text),
      remove: () => scope === 'chat' ? chat.deleteChat(created.id) : project.deleteProjectChat(created.id),
      done: scope === 'chat' ? 'chat:done' : 'projectChat:done',
      titleEvent: scope === 'chat' ? 'chat:title' : 'projectChat:title'
    }
  }
  it.each(['chat', 'project'] as const)('stops $0 generation on Save and rejects delayed chunks and completion', async (scope) => {
    let release!: (result: unknown) => void
    let request!: ChatStreamOptions
    mock.stream.mockImplementation((options: ChatStreamOptions) => {
      request = options; options.onDelta('Partial answer')
      return new Promise((resolve) => { release = resolve })
    })
    const c = titleChat(scope)
    await c.send('Explain'); await vi.waitFor(() => expect(mock.stream).toHaveBeenCalledOnce())
    const before = authoring.getAuthoringCourse(target.courseId)
    const saved = authoring.saveDraft(target.courseId, { ...before.draft.manifest, title: 'Edited course' }, before.document.revision, before.draft.draftVersion)
    if ('status' in saved) throw new Error('Conflict')
    expect(await authoring.saveCourse(target.courseId, before.document.revision, saved.draftVersion)).toMatchObject({ status: 'ok' })
    expect(request.signal?.aborted).toBe(true)
    expect(c.get().messages.at(-1)).toMatchObject({ text: 'Partial answer', status: 'stopped' })
    const transcript = c.get().messages
    request.onDelta('Late chunk')
    release({ text: 'Late answer', aborted: false, citations: [], output: [] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(c.get().messages).toEqual(transcript)
    expect(mock.title).not.toHaveBeenCalled()
    if (scope === 'chat') expect(chat.isAnswering(c.id)).toBe(false)
  })
  it('refreshes lesson context after an edit while retaining its historical snapshot', async () => {
    const c = titleChat('chat')
    await c.send('First'); await settled(c.done)
    const original = c.get().messages.find((m) => m.role === 'context')!
    const before = authoring.getAuthoringCourse(target.courseId)
    const manifest = structuredClone(before.draft.manifest)
    manifest.modules[0].lessons![0].blocks[0] = { ...manifest.modules[0].lessons![0].blocks[0], type: 'markdown', content: 'Updated explanation' }
    const saved = authoring.saveDraft(target.courseId, manifest, before.document.revision, before.draft.draftVersion)
    if ('status' in saved) throw new Error('Conflict')
    await authoring.saveCourse(target.courseId, before.document.revision, saved.draftVersion)
    sender.send.mockClear()
    await c.send('Second'); await settled(c.done)
    const contexts = c.get().messages.filter((m) => m.role === 'context')
    expect(contexts).toHaveLength(2); expect(contexts[0]).toEqual(original)
    expect(contexts[1].contextFingerprint).not.toBe(original.contextFingerprint)
    expect(contexts[1].text).toContain('Updated explanation')
  })
  it.each(titleCases)('uses independent title settings for $scope answers through $provider', async ({ scope, provider }) => {
    mock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('Answer')
      return { text: 'Answer', aborted: false, citations: [], output: [] }
    })
    const answerModel = provider === 'apiKey' ? 'gpt-4.1' : 'gpt-5.3-codex'
    await ai.setAIProfile(scope, provider, profile(answerModel))
    ai.setAIProvider(scope, provider)
    const titleProvider: 'apiKey' | 'chatgpt' = provider === 'apiKey' ? 'chatgpt' : 'apiKey'
    const config = { provider: titleProvider, model: titleProvider === 'apiKey' ? 'gpt-5.1' : 'gpt-5.3-codex', reasoning: 'high' as const }
    await ai.setTitleGenerationSettings(config)
    const c = titleChat(scope)
    await c.send('Explain callbacks'); await settled(c.titleEvent)
    expect(mock.stream.mock.calls[0][0]).toMatchObject({ provider, model: answerModel, key: provider === 'apiKey' ? 'sk-test-api' : 'subscription-token-one' })
    expect(mock.title.mock.calls[0][0]).toMatchObject({ ...config, key: titleProvider === 'apiKey' ? 'sk-test-api' : 'subscription-token-one' })
    expect(readPreferences().titleGeneration).toEqual(config)
    expect(c.get().messages.at(-1)?.generation).toEqual({ model: answerModel, provider, reasoning: null })
  })
  it('validates title settings separately from chat allowlists, persists them, and restores conversation defaults', async () => {
    await ai.setAIProfile('chat', 'apiKey', profile('gpt-4.1'))
    const config = { provider: 'apiKey' as const, model: 'gpt-5.1', reasoning: 'high' as const }
    await ai.setTitleGenerationSettings(config)
    expect((await ai.getTitleGenerationSettings()).config).toEqual(config)
    await expect(ai.setTitleGenerationSettings({ ...config, model: 'gpt-missing' })).rejects.toThrow('available')
    await expect(ai.setTitleGenerationSettings({ ...config, model: 'gpt-4.1' })).rejects.toThrow('reasoning')
    await expect(ai.setTitleGenerationSettings({ ...config, provider: 'unknown' as never })).rejects.toThrow('valid')
    expect(readPreferences().titleGeneration).toEqual(config)
    closeDb(); switchUser(createUser('Other title user').id)
    expect((await ai.getTitleGenerationSettings()).config).toBeNull()
    switchUser(owner)
    expect((await ai.getTitleGenerationSettings()).config).toEqual(config)
    await ai.setTitleGenerationSettings(null)
    expect(readPreferences().titleGeneration).toBeUndefined()
    const c = titleChat('chat')
    await c.send('Explain callbacks'); await settled(c.titleEvent)
    expect(mock.title.mock.calls[0][0]).toMatchObject({ provider: 'apiKey', model: 'gpt-4.1' })
    expect(mock.title.mock.calls[0][0].reasoning).toBeUndefined()
  })
  it('keeps answers successful when the dedicated title connection is unavailable', async () => {
    await ai.setTitleGenerationSettings({ provider: 'chatgpt', model: 'gpt-5.3-codex', reasoning: 'low' })
    mock.ready = false
    const c = titleChat('chat')
    await c.send('Explain callbacks'); await settled(c.done)
    expect(c.get().chat.title).toBe('Explain callbacks')
    expect(c.get().messages.at(-1)?.status).toBe('complete')
    expect(mock.title).not.toHaveBeenCalled()
    expect(sender.send.mock.calls.some(([channel]) => channel.endsWith(':error'))).toBe(false)
  })
  it('cancels naming through its own connection even when the answer used a key', async () => {
    await ai.setTitleGenerationSettings({ provider: 'chatgpt', model: 'gpt-5.3-codex', reasoning: 'low' })
    let release!: (result: { text: string; aborted: boolean }) => void
    mock.title.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const c = titleChat('chat')
    await c.send('Explain callbacks'); await settled(c.done)
    await vi.waitFor(() => expect(mock.title).toHaveBeenCalledOnce())
    const request = mock.title.mock.calls[0][0] as ChatStreamOptions
    chat.cancelAllChats('chatgpt')
    expect(request.signal?.aborted).toBe(true)
    release({ text: 'Late Subscription Title', aborted: false })
    await new Promise(resolve => setImmediate(resolve))
    expect(c.get().chat.title).toBe('Explain callbacks')
  })
  it.each(titleCases)('names $scope chats through $provider after the answer, keeps prompt titles while streaming, and persists once', async ({ scope, provider }) => {
    const model = provider === 'apiKey' ? 'gpt-5.1' : 'gpt-5.3-codex'
    await ai.getAIModelSettings(scope, provider)
    await ai.setAIProfile(scope, provider, profile(model, 'high'))
    ai.setAIProvider(scope, provider)
    const c = titleChat(scope)
    expect(c.get().chat.title).toBe('')
    expect(mock.title).not.toHaveBeenCalled()
    let releaseAnswer!: () => void
    let releaseTitle!: (result: { text: string; aborted: boolean }) => void
    mock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('The event loop schedules callbacks.')
      return { text: 'The event loop schedules callbacks.', aborted: false, citations: [], output: [] }
    }).mockImplementationOnce(async (options: ChatStreamOptions) => {
      options.onDelta('The event loop schedules callbacks.')
      await new Promise<void>(resolve => { releaseAnswer = resolve })
      return { text: 'The event loop schedules callbacks.', aborted: false, citations: [], output: [] }
    })
    mock.title.mockImplementationOnce(() => new Promise(resolve => { releaseTitle = resolve }))
    const prompt = 'How does the event loop work?'
    expect(await c.send(prompt)).toMatchObject({ status: 'ok' })
    await vi.waitFor(() => expect(releaseAnswer).toBeTypeOf('function'))
    expect(c.get().chat.title).toBe(prompt)
    expect(c.list().find(row => row.id === c.id)?.title).toBe(prompt)
    expect(mock.title).not.toHaveBeenCalled()
    releaseAnswer()
    await settled(c.done)
    expect(mock.title).toHaveBeenCalledTimes(1)
    const request = mock.title.mock.calls[0][0] as ChatStreamOptions
    expect(request).toMatchObject({ provider, model, key: provider === 'apiKey' ? 'sk-test-api' : 'subscription-token-one' })
    expect(request.reasoning).toBe('low')
    expect(request.tools).toBeUndefined()
    expect(request.webSearch).toBeUndefined()
    expect(request.input).toEqual([
      { role: 'system', content: TITLE_INSTRUCTIONS },
      { role: 'user', content: JSON.stringify({ prompt, response: 'The event loop schedules callbacks.' }) }
    ])
    expect(c.get().chat.title).toBe(prompt)
    expect(c.get().messages.filter(message => message.role !== 'context')).toHaveLength(2)
    expect(c.get().messages.at(-1)?.generation).toEqual({ model, provider, reasoning: 'high' })
    // Another message can complete while naming is pending, without starting a second title request.
    sender.send.mockClear()
    expect(await c.send('Show an example')).toMatchObject({ status: 'ok' })
    await settled(c.done)
    expect(mock.title).toHaveBeenCalledTimes(1)
    releaseTitle({ text: '“Understanding the Event Loop”', aborted: false })
    await vi.waitFor(() => expect(c.get().chat.title).toBe('Understanding the Event Loop'))
    expect(sender.send).toHaveBeenCalledWith(c.titleEvent, c.id, 'Understanding the Event Loop')
    expect(c.get().messages.filter(message => message.role !== 'context')).toHaveLength(4)
    closeDb()
    expect(c.list().find(row => row.id === c.id)?.title).toBe('Understanding the Event Loop')
    sender.send.mockClear()
    await c.send('One more example'); await settled(c.done)
    expect(mock.title).toHaveBeenCalledTimes(1)
  })
  it.each(['chat', 'project'] as const)('keeps completed %s answers successful when naming fails, and does not name stopped replies', async scope => {
    const c = titleChat(scope)
    mock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('A completed explanation')
      return { text: 'A completed explanation', aborted: false, citations: [], output: [] }
    })
    mock.title.mockRejectedValue(new Error('Title request unavailable'))
    await c.send('Explain callbacks'); await settled(c.done)
    expect(c.get().chat.title).toBe('Explain callbacks')
    expect(c.get().messages.at(-1)?.status).toBe('complete')
    expect(sender.send.mock.calls.some(([channel]) => channel.endsWith(':error'))).toBe(false)
    const stopped = titleChat(scope)
    sender.send.mockClear(); mock.title.mockClear()
    mock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('Partial explanation')
      return { text: 'Partial explanation', aborted: true, citations: [], output: [] }
    })
    await stopped.send('Explain promises'); await settled(stopped.done)
    expect(stopped.get().chat.title).toBe('Explain promises')
    expect(stopped.get().messages.at(-1)?.status).toBe('stopped')
    expect(mock.title).not.toHaveBeenCalled()
  })
  it.each(['chat', 'project'] as const)('cancels pending %s titles on deletion and user changes, ignoring late results', async scope => {
    mock.stream.mockImplementation(async (options: ChatStreamOptions) => {
      options.onDelta('A completed explanation')
      return { text: 'A completed explanation', aborted: false, citations: [], output: [] }
    })
    let release!: (result: { text: string; aborted: boolean }) => void
    mock.title.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const deleted = titleChat(scope)
    await deleted.send('Explain callbacks'); await settled(deleted.done)
    const deletedRequest = mock.title.mock.calls[0][0] as ChatStreamOptions
    deleted.remove()
    expect(deletedRequest.signal?.aborted).toBe(true)
    release({ text: 'Late Deleted Title', aborted: false })
    await new Promise(resolve => setImmediate(resolve))
    expect(deleted.list()).toEqual([])
    expect(sender.send.mock.calls.some(([channel]) => channel === deleted.titleEvent)).toBe(false)
    sender.send.mockClear()
    const switched = titleChat(scope)
    await switched.send('Explain promises'); await settled(switched.done)
    const switchedRequest = mock.title.mock.calls[1][0] as ChatStreamOptions
    chat.cancelAllChats(); project.cancelAllProjectChats(); closeDb()
    switchUser(createUser('Other learner').id)
    expect(switchedRequest.signal?.aborted).toBe(true)
    release({ text: 'Late Other Title', aborted: false })
    await new Promise(resolve => setImmediate(resolve))
    switchUser(owner)
    expect(switched.get().chat.title).toBe('Explain promises')
    expect(sender.send.mock.calls.some(([channel]) => channel === switched.titleEvent)).toBe(false)
  })
  it('uses low reasoning when naming GPT-6.1 instead of the unsupported none setting', async () => {
    mock.fetch.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }) }))
    await ai.setAIProfile('chat', 'apiKey', profile('gpt-6.1-sol', 'high'))
    const c = titleChat('chat')
    mock.title.mockImplementation(async (options: ChatStreamOptions) => {
      if (options.reasoning === 'none') throw new Error('Unsupported value: none is not supported with gpt-6.1-sol')
      return { text: 'Event Loop Basics', aborted: false, citations: [] }
    })
    await c.send('How does the event loop work?'); await settled(c.done)
    await vi.waitFor(() => expect(c.get().chat.title).toBe('Event Loop Basics'))
    expect(mock.title.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: 'low' })
    await ai.setAIProfile('chat', 'apiKey', profile('gpt-6.1-sol', 'low'))
    expect(c.get().messages.at(-1)?.generation).toEqual({ model: 'gpt-6.1-sol', provider: 'apiKey', reasoning: 'high' })
  })
  it('persists four independent profiles and rejects invalid defaults without changing settings', async () => {
    writePreferences({ defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high', chatModels: ['gpt-5.1'] })
    await ai.getAIModelSettings('chat', 'chatgpt')
    await ai.setAIProfile('chat', 'apiKey', profile('gpt-4.1'))
    await ai.setAIProfile('project', 'apiKey', profile('gpt-5.1', 'high'))
    await ai.setAIProfile('chat', 'chatgpt', profile('gpt-5.3-codex', 'low'))
    await ai.setAIProfile('project', 'chatgpt', profile('gpt-5.3-codex', 'high'))
    const saved = readPreferences().ai!
    await expect(ai.setAIProfile('chat', 'apiKey', { ...profile('gpt-4.1'), enabledModels: [] })).rejects.toThrow('available')
    await expect(ai.setAIProfile('chat', 'apiKey', profile('gpt-missing'))).rejects.toThrow('available')
    await expect(ai.setAIProfile('chat', 'apiKey', profile('gpt-4.1', 'high'))).rejects.toThrow('reasoning')
    closeDb(); switchUser(createUser('Other').id); switchUser(owner)
    expect(readPreferences().ai).toEqual(saved)
    expect(saved.chat.profiles.apiKey).not.toEqual(saved.project.profiles.apiKey)
    expect(saved.chat.profiles.chatgpt.defaultReasoning).toBe('low')
    expect(saved.project.profiles.chatgpt.defaultReasoning).toBe('high')
  })
  it.each(['chat', 'project'] as const)('persists an empty %s allowlist for each connection and can restore all models', async scope => {
    const empty = { enabledModels: [], defaultModel: null, defaultReasoning: null }
    const otherScope = scope === 'chat' ? 'project' : 'chat'
    for (const provider of ['apiKey', 'chatgpt'] as const) {
      const initial = await ai.getAIModelSettings(scope, provider)
      const other = (await ai.getAIModelSettings(otherScope, provider)).profile
      await ai.setAIProfile(scope, provider, empty)
      expect((await ai.getAIModelSettings(scope, provider)).profile).toEqual(empty)
      expect((await ai.getAIModelSettings(otherScope, provider)).profile).toEqual(other)
      ai.setAIProvider(scope, provider)
      expect((await ai.aiPickerModels(scope)).models).toEqual([])
      await expect(ai.prepareAIRequest(scope, { model: initial.models[0].id, reasoning: null })).rejects.toThrow('No models are allowed')
      await ai.setAIProfile(scope, provider, { enabledModels: null, defaultModel: initial.models[0].id, defaultReasoning: null })
      expect((await ai.aiPickerModels(scope)).models).toEqual(initial.models)
    }
    expect(mock.stream).not.toHaveBeenCalled()
  })
  it('routes lesson chat and project review independently and never uses subscription credentials for missing API access', async () => {
    await ai.getAIModelSettings('chat', 'chatgpt')
    await ai.setAIProfile('chat', 'chatgpt', profile('gpt-5.3-codex', 'low'))
    await ai.setAIProfile('project', 'apiKey', profile('gpt-5.1', 'high'))
    ai.setAIProvider('chat', 'chatgpt')
    const c = chat.createChat(target.courseId, lesson), p = project.createProjectChat(target)
    expect(await chat.sendChatMessage(sender as never, c.id, 'Explain', undefined, lesson)).toMatchObject({ status: 'ok' })
    await settled('chat:done')
    expect(await project.sendProjectMessage(sender as never, p.id, '', undefined, true)).toMatchObject({ status: 'ok' })
    await settled('projectChat:done')
    expect(mock.stream.mock.calls[0][0]).toMatchObject({ provider: 'chatgpt', key: 'subscription-token-one', model: 'gpt-5.3-codex', reasoning: 'low' })
    expect(mock.stream.mock.calls[1][0]).toMatchObject({ provider: 'apiKey', key: 'sk-test-api', model: 'gpt-5.1', reasoning: 'high' })
    mock.key = ''
    expect(await project.sendProjectMessage(sender as never, p.id, 'Again')).toMatchObject({ status: 'no-key' })
    expect(mock.stream).toHaveBeenCalledTimes(2)
  })
  it('keeps in-flight settings until completion, switches on the next message, and preserves history and individual selections', async () => {
    await ai.setAIProfile('chat', 'apiKey', { ...profile('gpt-5.1'), enabledModels: null })
    await ai.getAIModelSettings('chat', 'chatgpt')
    const c = chat.createChat(target.courseId, lesson)
    chat.setChatReasoning(c.id, 'high')
    let release!: () => void
    mock.stream.mockImplementationOnce(async (options: ChatStreamOptions) => { options.onDelta('First'); await new Promise<void>(resolve => { release = resolve }); return { text: 'First', aborted: false, citations: [], output: [] } })
    await chat.sendChatMessage(sender as never, c.id, 'First question', undefined, lesson)
    ai.setAIProvider('chat', 'chatgpt')
    expect(chat.getChat(c.id)!.chat).toMatchObject({ provider: 'apiKey', model: 'gpt-5.1', reasoning: 'high' })
    expect(() => chat.setChatModel(c.id, 'gpt-4.1')).toThrow('current response')
    release(); await settled('chat:done')
    expect(chat.getChat(c.id)!.chat).toMatchObject({ provider: 'chatgpt', model: 'gpt-5.3-codex', reasoning: null })
    sender.send.mockClear()
    await chat.sendChatMessage(sender as never, c.id, 'Second question', undefined, lesson); await settled('chat:done')
    expect(mock.stream.mock.calls[1][0].input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: 'First' })]))
    await ai.setAIProfile('chat', 'chatgpt', profile('gpt-5.3-codex', 'high'))
    expect(chat.getChat(c.id)!.chat.reasoning).toBe(null)
  })
  it('uses only an account’s labeled cache, isolates local users, and blocks unavailable defaults without API fallback', async () => {
    await ai.getAIModelSettings('chat', 'chatgpt')
    ai.setAIProvider('chat', 'chatgpt')
    mock.account = 'two'; ai.notifyAIConnectionChanged()
    expect((await ai.getAIModelSettings('chat', 'chatgpt')).models.map(m => m.id)).toEqual(['gpt-6.1-sol'])
    const c = chat.createChat(target.courseId, lesson)
    expect(await chat.sendChatMessage(sender as never, c.id, 'Ask', undefined, lesson)).toMatchObject({ status: 'connection-required', provider: 'chatgpt', message: expect.stringContaining('default model') })
    expect(mock.stream).not.toHaveBeenCalled()
    mock.fetch.mockRejectedValue(new Error('Offline'))
    expect(await ai.getAIModelSettings('chat', 'chatgpt', true)).toMatchObject({ source: 'cache', models: [{ id: 'gpt-6.1-sol' }], error: 'Offline' })
    switchUser(createUser('Other').id)
    expect(await ai.getAIModelSettings('chat', 'chatgpt')).toMatchObject({ source: 'fallback', models: [], error: 'Offline' })
  })
  it('refreshes catalogs after replacement even when connection readiness remains true', async () => {
    await ai.getAIModelSettings('chat', 'chatgpt')
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    ai.notifyAIConnectionChanged()
    await ai.getAIModelSettings('project', 'chatgpt')
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    mock.key = 'sk-replaced-api'
    await ai.getAIModelSettings('chat', 'apiKey')
    expect(mock.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer sk-replaced-api')
  })
  it('can stop token preparation promptly, prevents duplicate sends, and never sends a late result', async () => {
    await ai.getAIModelSettings('chat', 'chatgpt'); ai.setAIProvider('chat', 'chatgpt')
    const c = chat.createChat(target.courseId, lesson)
    let release!: (token: string) => void
    mock.token.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const sending = chat.sendChatMessage(sender as never, c.id, 'Ask', undefined, lesson)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await chat.sendChatMessage(sender as never, c.id, 'Duplicate', undefined, lesson)).toMatchObject({ status: 'busy' })
    chat.cancelChat(c.id)
    expect(await sending).toMatchObject({ status: 'failed', message: expect.stringContaining('stopped') })
    release('late-token'); await new Promise(resolve => setImmediate(resolve))
    expect(mock.stream).not.toHaveBeenCalled()
    expect(chat.getChat(c.id)!.messages).toEqual([])
  })
})
