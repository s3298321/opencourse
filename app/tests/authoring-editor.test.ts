import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CourseEditor from '../src/renderer/routes/CourseEditor'
import type { AuthoringCourse } from '../src/core/course-document'
import type { AuthoringTarget, ChatSummary } from '../src/core/types'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/routes/CourseEditorFields', () => ({
  EditorAttachments: ({ children }: { children: unknown }) => children,
  EditorValidation: ({ children }: { children: unknown }) => children,
  CourseFields: () => createElement('input', { 'aria-label': 'Manual course fields' }),
  ElementFields: () => createElement('input', { 'aria-label': 'Manual element fields' })
}))
vi.mock('../src/renderer/routes/CourseEditorPreview', () => ({
  BlockPreview: ({ block }: { block: { content: string } }) => createElement('p', null, block.content),
  LessonPreview: ({ lesson }: { lesson: { title: string; blocks: { content: string }[] } }) => createElement('div', null, createElement('h1', null, lesson.title), ...lesson.blocks.map((block, i) => createElement('p', { key: i }, block.content))),
  CourseCoverPreview: () => null, ProjectPreview: () => null,
  FlashcardPreview: ({ card }: { card: { question: string } }) => createElement('p', null, card.question)
}))
let root: Root | undefined
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })
async function fixture(existingChats: string[] = [], saved = false) {
  const initial = { schema_version: '1.3', slug: 'demo', title: 'Demo', modules: [{ nodeId: 'module', slug: 'module', title: 'Module', lessons: [{ nodeId: 'lesson', slug: 'lesson', title: 'Lesson', blocks: [{ nodeId: 'block', type: 'markdown' as const, slug: 'intro', content: 'Initial content' }] }] }] }
  let state: AuthoringCourse = { document: { version: 1, courseId: 'demo', revision: saved ? 1 : 0, manifest: saved ? structuredClone(initial) : null, attachments: [] }, draft: { courseId: 'demo', baseRevision: saved ? 1 : 0, draftVersion: 1, manifest: initial, dirty: false } }
  const listeners: Record<string, (...args: never[]) => void> = {}
  const subscribe = (name: string) => (handler: (...args: never[]) => void) => { listeners[name] = handler; return () => { delete listeners[name] } }
  let chats: ChatSummary[] = []
  const summary = (id: string): ChatSummary => ({ id, courseId: 'demo', model: 'gpt-5.1', reasoning: null, provider: 'apiKey', title: '', messages: 0, startedIn: null, createdAt: 'now', updatedAt: 'now' })
  chats = existingChats.map(summary)
  const send = vi.fn(async () => ({ status: 'ok', seq: 0 }))
  const stop = vi.fn(async () => {})
  const api = {
    getAuthoringCourse: async () => structuredClone(state),
    saveCourseDraft: vi.fn(async (_id, manifest, revision, draftVersion) => { state = { ...state, draft: { ...state.draft, manifest, baseRevision: revision, draftVersion: draftVersion + 1, dirty: true } }; return structuredClone(state.draft) }),
    saveCourse: vi.fn(async (_id: string, revision: number) => {
      state = { document: { ...state.document, revision: revision + 1, manifest: structuredClone(state.draft.manifest) }, draft: { ...state.draft, baseRevision: revision + 1, draftVersion: 0, dirty: false } }
      return { status: 'ok', revision: revision + 1 }
    }),
    setEditorActive: vi.fn(async () => {}),
    listAuthoringChats: async () => structuredClone(chats), getAuthoringChat: vi.fn(async (id: string) => ({ chat: summary(id), messages: [] })),
    createAuthoringChat: vi.fn(async () => { const chat = summary(`chat-${chats.length}`); chats.push(chat); return chat }),
    deleteAuthoringChat: async () => {}, cancelAuthoringChat: async () => {}, setAuthoringChatModel: async (id: string) => summary(id), setAuthoringChatReasoning: async (id: string) => summary(id),
    sendAuthoringMessage: send, stopCourseAuthoring: stop, getAuthoringRunState: async () => ({ chatId: null }),
    onAuthoringDraftChanged: subscribe('draft'), onAuthoringRunState: subscribe('run'),
    onAuthoringChatDelta: subscribe('delta'), onAuthoringChatDone: subscribe('done'), onAuthoringChatTitle: subscribe('title'), onAuthoringChatError: subscribe('error'), onAuthoringChatActivity: subscribe('activity'),
    onAIChanged: () => () => {}, listChatModels: async () => ({ models: [{ id: 'gpt-5.1', label: 'GPT' }], webSearch: false, connection: { provider: 'apiKey', ready: true } }),
    resolveAuthoringAsset: async (_id: string, path: string) => path
  }
  vi.stubGlobal('opencourse', api)
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const register = vi.fn(), navigate = vi.fn(), onDirty = vi.fn()
  await act(async () => root!.render(createElement(CourseEditor, { courseId: 'demo', user: { id: 'author', name: 'Author' } as never, route: { name: 'courseEditor', courseId: 'demo' }, navigate, registerEditor: register, onDirty, ask: vi.fn(async () => true) })))
  const flush = async () => { await act(async () => { await register.mock.calls.filter(([handle]) => handle).at(-1)![0].flush() }) }
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
  const emit = (name: string, ...args: unknown[]) => listeners[name]?.(...args as never[])
  const type = async (text: string) => { const input = container.querySelector<HTMLTextAreaElement>('.sidechat-input')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
  return { container, button, api, emit, type, send, stop, register, flush, onDirty, state: () => state }
}
async function highlight(node: Node, text: string) {
  const start = node.textContent!.indexOf(text), range = document.createRange()
  range.setStart(node, start); range.setEnd(node, start + text.length)
  Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 120, top: 180, width: 100, height: 20 }) })
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await act(async () => node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
}
describe('course editor AI mode', () => {
  it('adds flashcards outside blocks, selects and duplicates them, and upgrades the draft to the current format in the edit session', async () => {
    const f = await fixture()
    await act(async () => f.button('+ Add card').click())
    expect(f.container.querySelector('[aria-label="Move card to lesson"]')).toBeNull()
    expect(f.container.querySelector('.outline-row.selected')?.getAttribute('aria-label')).toBe('Flashcard: card')
    await f.flush()
    expect(f.state().draft.manifest).toMatchObject({ schema_version: '1.5', version: '0.1.0' })
    expect(f.state().draft.manifest.modules[0].lessons![0].blocks).toHaveLength(1)
    expect(f.state().draft.manifest.modules[0].lessons![0].flashcards).toHaveLength(1)
    await act(async () => f.button('Duplicate').click())
    await f.flush()
    expect(f.state().draft.manifest.modules[0].lessons![0].flashcards).toHaveLength(2)
    const [first, copy] = f.state().draft.manifest.modules[0].lessons![0].flashcards!
    expect(copy.nodeId).not.toBe(first.nodeId)
    await act(async () => f.button('Delete').click())
    await f.flush()
    expect(f.state().draft.manifest.modules[0].lessons![0].flashcards).toHaveLength(1)
  })
  it('collapses modules and lessons independently without changing the preview, in both modes', async () => {
    const f = await fixture()
    const toggle = (label: string) => f.container.querySelector<HTMLButtonElement>(`.outline-toggle[aria-label="${label}"]`)!
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Text: intro"]')!.click())
    const moduleIcon = f.container.querySelector('[aria-label="Module"] .outline-icon')
    expect(moduleIcon?.tagName.toLowerCase()).toBe('svg')
    await act(async () => toggle('Collapse Lesson').click())
    expect(toggle('Expand Lesson').getAttribute('aria-expanded')).toBe('false')
    expect(f.container.querySelector('[aria-label="Text: intro"]')).toBeNull()
    expect(f.button('Add block')).toBeUndefined()
    expect(f.container.querySelector('.author-preview')?.textContent).toContain('Initial content')
    expect(JSON.parse(localStorage.getItem('authoring:author:demo:editor')!).selected).toBe('block')
    await act(async () => toggle('Collapse Module').click())
    expect(f.container.querySelector('[aria-label="Lesson"]')).toBeNull()
    expect(f.button('+ Add lesson')).toBeUndefined()
    await act(async () => f.button('AI').click())
    expect(toggle('Expand Module').getAttribute('aria-expanded')).toBe('false')
    await act(async () => { f.emit('run', 'demo', { chatId: 'chat-0' }); toggle('Expand Module').click() })
    expect(toggle('Expand Lesson')).toBeTruthy()
    expect(f.container.querySelector('[aria-label="Text: intro"]')).toBeNull()
    await act(async () => toggle('Expand Lesson').click())
    expect(f.container.querySelector('.outline-row.selected')?.getAttribute('aria-label')).toBe('Text: intro')
    expect(toggle('Collapse Lesson').getAttribute('aria-expanded')).toBe('true')
    expect(f.api.saveCourseDraft).not.toHaveBeenCalled()
  })
  it('restores collapsed branches and preserves them when draft references become saved identities', async () => {
    localStorage.setItem('authoring:author:demo:editor', JSON.stringify({ mode: 'ai', collapsed: ['module', 'lesson', 'deleted', 3] }))
    const f = await fixture()
    expect(f.container.querySelector('[aria-label="Expand Module"]')).toBeTruthy()
    expect(f.container.querySelector('[aria-label="Lesson"]')).toBeNull()
    const next = structuredClone(f.state())
    next.draft.manifest.modules[0].nodeId = 'saved-module'
    next.draft.manifest.modules[0].lessons![0].nodeId = 'saved-lesson'
    next.draft.draftVersion++
    await act(async () => f.emit('draft', 'demo', next, { module: 'saved-module', lesson: 'saved-lesson' }))
    expect(JSON.parse(localStorage.getItem('authoring:author:demo:editor')!).collapsed).toEqual(['saved-module', 'saved-lesson'])
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Expand Module"]')!.click())
    expect(f.container.querySelector('[aria-label="Expand Lesson"]')).toBeTruthy()
    expect(f.container.querySelector('[aria-label="Text: intro"]')).toBeNull()
  })
  it('attaches a highlighted preview passage, keeps it marked while typing, and sends it with the current block', async () => {
    const highlights = new Map()
    vi.stubGlobal('CSS', { highlights }); vi.stubGlobal('Highlight', class { constructor(public range: Range) {} })
    const f = await fixture(); await act(async () => f.button('AI').click())
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Text: intro"]')!.click())
    await highlight(f.container.querySelector('.author-preview p')!.firstChild!, 'Initial')
    const offer = f.button('Ask about this')
    expect(offer).toBeTruthy()
    await act(async () => { offer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); offer.click() })
    expect(f.container.querySelector('.ask-about')).toBeNull()
    expect(f.container.querySelector('.sidechat-quote')?.textContent).toContain('From the preview')
    expect(f.container.querySelector('.sidechat-quote')?.textContent).toContain('Initial')
    expect(highlights.has('ask-quote')).toBe(true)
    expect(document.activeElement).toBe(f.container.querySelector('.sidechat-input'))
    await f.type('Explain and improve this passage')
    expect(highlights.has('ask-quote')).toBe(true)
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click())
    expect(f.send).toHaveBeenCalledWith('chat-0', 'Explain and improve this passage', { kind: 'block', ref: 'block' }, 0, 1, { text: 'Initial', from: 'preview' })
    expect(f.container.querySelector('.sidechat-quote')).toBeNull()
    expect(highlights.has('ask-quote')).toBe(false)
  })
  it('ignores manual fields and clears preview quotes when moving to another block or manual mode', async () => {
    const f = await fixture(); await act(async () => f.button('AI').click())
    await highlight(f.container.querySelector('.author-header h1')!.firstChild!, 'Demo')
    expect(f.container.querySelector('.ask-about')).toBeNull()
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Text: intro"]')!.click())
    await highlight(f.container.querySelector('.author-preview p')!.firstChild!, 'Initial')
    await act(async () => f.button('Ask about this').click())
    await act(async () => f.button('Course details').click())
    expect(f.container.querySelector('.sidechat-quote')).toBeNull()
    await highlight(f.container.querySelector('.author-preview h1')!.firstChild!, 'Demo')
    await act(async () => f.button('Ask about this').click())
    await act(async () => f.button('Manual').click())
    expect(f.container.querySelector('.sidechat-quote')).toBeNull()
    await highlight(f.container.querySelector('.author-preview h1')!.firstChild!, 'Demo')
    expect(f.container.querySelector('.ask-about')).toBeNull()
  })
  it('restores only tabs belonging to this course before loading their history', async () => {
    localStorage.setItem('authoring:author:demo:editor', JSON.stringify({ mode: 'ai', selected: 'block' }))
    localStorage.setItem('authoring:author:demo:tabs', JSON.stringify({ tabs: ['restored', 'another-course'], active: 'another-course' }))
    const f = await fixture(['restored'])
    expect(f.api.getAuthoringChat).not.toHaveBeenCalledWith('another-course')
    expect(f.api.getAuthoringChat).toHaveBeenCalledWith('restored')
    expect(f.api.createAuthoringChat).not.toHaveBeenCalled()
    expect(f.container.querySelector('.outline-row.selected')?.textContent).toContain('intro')
    expect(JSON.parse(localStorage.getItem('authoring:author:demo:tabs')!).tabs).toEqual(['restored'])
  })
  it('keeps outline, selection, tabs and composer across modes while hiding manual fields', async () => {
    const f = await fixture()
    const creationButtons = ['+Add block', '+ Add card', '+ Add lesson', 'Add module', 'Add project']
    creationButtons.forEach(label => expect(f.button(label)).toBeTruthy())
    expect(f.api.createAuthoringChat).not.toHaveBeenCalled()
    await act(async () => f.button('AI').click())
    expect(f.container.querySelector('.course-editor')?.classList.contains('ai-mode')).toBe(true)
    expect(f.container.querySelector<HTMLElement>('.author-form')?.hidden).toBe(true)
    creationButtons.forEach(label => expect(f.button(label)).toBeUndefined())
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Text: intro"]')!.click())
    expect(f.container.querySelector('.author-preview')?.textContent).toContain('Initial content')
    await f.type('Improve this block')
    await act(async () => f.button('Manual').click())
    expect(f.container.querySelector<HTMLElement>('.author-form')?.hidden).toBe(false)
    expect(f.container.querySelector<HTMLElement>('.author-chat-column')?.hidden).toBe(true)
    creationButtons.forEach(label => expect(f.button(label)).toBeTruthy())
    await act(async () => f.button('AI').click())
    expect(f.container.querySelector<HTMLTextAreaElement>('.sidechat-input')?.value).toBe('Improve this block')
    // The open tab is a draft: its chat is created by the first message, not by opening the panel.
    expect(f.api.createAuthoringChat).not.toHaveBeenCalled()
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click())
    await act(async () => {})
    expect(f.api.createAuthoringChat).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledWith('chat-0', 'Improve this block', { kind: 'block', ref: 'block' } satisfies AuthoringTarget, 0, 1, undefined)
  })
  it('updates the live preview, locks changes during a run and falls back when selected content is deleted', async () => {
    const f = await fixture(); await act(async () => f.button('AI').click())
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Text: intro"]')!.click())
    const next = structuredClone(f.state()); next.draft.manifest.modules[0].lessons![0].blocks[0] = { nodeId: 'block', type: 'markdown', slug: 'intro', content: 'AI-generated content' }; next.draft.draftVersion++
    await act(async () => { f.emit('run', 'demo', { chatId: 'chat-0' }); f.emit('draft', 'demo', structuredClone(next)) })
    expect(f.container.querySelector('.author-preview')?.textContent).toContain('AI-generated content')
    expect(f.button('Add module')).toBeUndefined(); expect(f.button('Save').disabled).toBe(true)
    await act(async () => f.button('Manual').click())
    expect(f.button('Add module').disabled).toBe(true)
    expect(f.container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true)
    next.draft.manifest.modules[0].lessons![0].blocks = []
    await act(async () => { f.emit('draft', 'demo', structuredClone(next)); f.emit('run', 'demo', { chatId: null }) })
    expect(f.container.querySelector('.outline-row.selected')?.textContent).toBe('▤Lesson')
    expect(f.button('Add module').disabled).toBe(false)
    expect(f.container.querySelector('.author-header p[role="status"]')?.textContent).toBe('The assistant is done. Review its changes, then save.')
  })
  it('restores editor mode and tabs after reopening and stops a turn when the editor closes', async () => {
    const f = await fixture(); await act(async () => f.button('AI').click()); await f.type('Create a course')
    await act(async () => f.emit('run', 'demo', { chatId: 'chat-0' }))
    await act(async () => root!.unmount()); root = undefined
    expect(f.stop).toHaveBeenCalledWith('demo')
    expect(f.register).toHaveBeenLastCalledWith(null)
    expect(f.api.setEditorActive).toHaveBeenLastCalledWith(false)
    expect(JSON.parse(localStorage.getItem('authoring:author:demo:editor')!).mode).toBe('ai')
    // An untouched draft tab is never saved: there is no chat to come back to.
    expect(JSON.parse(localStorage.getItem('authoring:author:demo:tabs')!).tabs).toEqual([])
    expect(localStorage.getItem('authoring:author:demo:composer')).toBe('Create a course')
  })
})

describe('course editor saving', () => {
  const saveState = (f: Awaited<ReturnType<typeof fixture>>) => f.container.querySelector('.author-save-state')?.textContent
  it('shows unsaved changes until Save, and offers only the one action', async () => {
    const f = await fixture([], true)
    expect(f.api.setEditorActive).toHaveBeenCalledWith(true)
    expect(saveState(f)).toBe('All changes saved')
    expect(f.button('Save').disabled).toBe(true)
    expect(f.button('Discard draft')).toBeUndefined()
    expect(f.button('Save & export ZIP…')).toBeUndefined()
    await act(async () => f.button('+ Add card').click())
    expect(saveState(f)).toBe('Unsaved changes')
    expect(f.onDirty).toHaveBeenLastCalledWith(true)
    expect(f.button('Save').disabled).toBe(false)
    await act(async () => f.button('Save').click())
    expect(f.api.saveCourse).toHaveBeenCalledOnce()
    expect(saveState(f)).toBe('All changes saved')
    expect(f.onDirty).toHaveBeenLastCalledWith(false)
  })
  it('saves on ⌘S, and on the menu item, whichever field has focus', async () => {
    const f = await fixture([], true)
    await act(async () => f.button('+ Add card').click())
    await act(async () => { document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })) })
    await vi.waitFor(() => expect(f.api.saveCourse).toHaveBeenCalledOnce())
    await act(async () => f.button('+ Add card').click())
    await act(async () => { document.dispatchEvent(new Event('authoring:save')) })
    await vi.waitFor(() => expect(f.api.saveCourse).toHaveBeenCalledTimes(2))
  })
  it('lets a course that was never saved be saved before any edit, and says so', async () => {
    const f = await fixture()
    expect(saveState(f)).toBe('Not saved yet')
    expect(f.button('Save').disabled).toBe(false)
  })
})
