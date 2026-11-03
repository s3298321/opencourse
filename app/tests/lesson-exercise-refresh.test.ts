import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCourse } from '../src/core/manifest'
import { emptyProgress } from '../src/core/progress'
import type { CourseManifest, CourseView, ExerciseSession } from '../src/core/types'
import Lesson from '../src/renderer/routes/Lesson'

vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/components/Html', () => ({ default: ({ source }: { source: string }) => h('span', null, source) }))
vi.mock('../src/renderer/workbench/TestPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/workbench/TerminalView', () => ({ default: () => null }))

let root: Root, container: HTMLDivElement, course: CourseView | null
let manifest: CourseManifest
const listeners = new Set<() => void>()
const navigate = vi.fn()
const scrollRef = { current: { key: '', top: 0 } }
const session: ExerciseSession = {
  exerciseDir: '/exercise', courseDir: '/course', language: 'python', languageLabel: 'Python',
  indentUnit: '    ', learnerFile: 'main.py', testCommand: 'pytest', hasTests: true, canRun: true,
  content: 'print(1)', mtimeMs: 1
}
const updateCourse = () => { course = buildCourse(manifest, '/course', undefined, 'course') }
const render = async (lessonId = 'lesson') => act(async () => root.render(h(Lesson, {
  courseId: 'course', moduleId: 'module', lessonId, user: null, navigate, navSignal: null,
  route: { name: 'lesson', courseId: 'course', moduleId: 'module', lessonId },
  chatOpen: false, setChatOpen: vi.fn(), scrollRef, readingScale: 1, setReadingScale: vi.fn()
})))
const refresh = async () => act(async () => { for (const listener of listeners) listener() })
const open = async () => act(async () => {
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open editor')!.click()
})
const editor = () => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  manifest = { schema_version: '1.3', slug: 'course', title: 'Course', modules: [{
    slug: 'module', title: 'Module', lessons: [
      { slug: 'lesson', title: 'Lesson', blocks: [{ type: 'exercise', slug: 'exercise', id: 'exercise', title: 'Exercise', prompt: 'Write code.', verification_instructions: 'Run checks.' }] },
      { slug: 'next', title: 'Next lesson', blocks: [] }
    ]
  }] }
  updateCourse()
  navigate.mockReset()
  scrollRef.current = { key: '', top: 0 }
  vi.stubGlobal('opencourse', {
    getCourse: vi.fn(async () => course), touchLesson: vi.fn(async () => emptyProgress('course')),
    getProgress: vi.fn(async () => emptyProgress('course')),
    getNotebookStatus: vi.fn(async () => ({ enabled: false })), onNotebookEvent: () => () => {},
    onCoursesChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    openExercise: vi.fn(async () => session),
    readExerciseFile: vi.fn(async () => ({ content: session.content, mtimeMs: session.mtimeMs })),
    writeExerciseFile: vi.fn(async () => ({ ok: true, mtimeMs: 2 })),
    onRunData: () => () => {}, onEnvProgress: () => () => {}
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('exercise editor during course refreshes', () => {
  it('keeps the editor and unsaved code alive through background sync, then autosaves', async () => {
    vi.useFakeTimers()
    await render(); await open()
    const view = editor()
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(42)' } }))
    updateCourse()
    await refresh()
    expect(container.querySelector('.workbench')).not.toBeNull()
    expect(editor()).toBe(view)
    expect(view.state.doc.toString()).toBe('print(42)')
    expect(window.opencourse.openExercise).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(window.opencourse.writeExerciseFile).toHaveBeenCalledWith({ courseId: 'course', blockId: 'exercise' }, 'print(42)', 1)
  })

  it('updates the exercise brief without reopening the editor', async () => {
    await render(); await open()
    const view = editor()
    const module = manifest.modules[0]!
    if (module.type === 'project') throw new Error('Expected lessons')
    const exercise = module.lessons[0]!.blocks[0]!
    if (exercise.type !== 'exercise') throw new Error('Expected exercise')
    exercise.prompt = 'Updated instructions.'
    updateCourse(); await refresh()
    expect(container.querySelector('.workbench-brief')?.textContent).toContain('Updated instructions.')
    expect(editor()).toBe(view)
    expect(window.opencourse.openExercise).toHaveBeenCalledOnce()
    await act(async () => container.querySelector<HTMLButtonElement>('.workbench-back')!.click())
    expect(container.querySelector('.workbench')).toBeNull()
  })

  it('closes a removed exercise and does not reopen it if it returns in a later refresh', async () => {
    await render(); await open()
    const module = manifest.modules[0]!
    if (module.type === 'project') throw new Error('Expected lessons')
    const blocks = module.lessons[0]!.blocks
    module.lessons[0]!.blocks = []
    updateCourse(); await refresh()
    expect(container.querySelector('.workbench')).toBeNull()
    module.lessons[0]!.blocks = blocks
    updateCourse(); await refresh()
    expect(container.querySelector('.workbench')).toBeNull()
  })

  it('closes the exercise when navigating to another lesson', async () => {
    await render(); await open(); await render('next')
    expect(container.querySelector('.workbench')).toBeNull()
    await render()
    expect(container.querySelector('.workbench')).toBeNull()
  })

  it('returns to the library when the course is removed', async () => {
    await render(); await open()
    course = null; await refresh()
    expect(navigate).toHaveBeenCalledWith({ name: 'library' })
    expect(container.querySelector('.workbench')).toBeNull()
  })
})
