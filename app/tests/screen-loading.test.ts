import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CourseDetail from '../src/renderer/routes/CourseDetail'
import Lesson from '../src/renderer/routes/Lesson'
import CoachProject from '../src/renderer/routes/CoachProject'
import CoachTranscript from '../src/renderer/routes/CoachTranscript'

let root: Root, container: HTMLDivElement
const pending = () => new Promise<never>(() => {})
const unsubscribe = () => () => {}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('opencourse', {
    getCourse: pending, getProgress: pending, getReviewSummary: pending,
    touchCourse: pending, touchLesson: pending, onCoursesChanged: unsubscribe, onReviewChanged: unsubscribe,
    getCoachProjectRunState: vi.fn(async () => ({ busy: false })),
    getCoachProject: pending, listCoachFiles: pending, listCoachSessions: pending, listCoachModels: pending, listCoachBackendModels: pending,
    onCoachChanged: unsubscribe, onCoachFilesChanged: unsubscribe, getCoachTranscript: pending
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('page surfaces while navigation data is pending', () => {
  const shared = { user: null, navigate: vi.fn() }
  const screens = {
    'course overview': () => h(CourseDetail, { ...shared, courseId: 'course', route: { name: 'course', courseId: 'course' } }),
    lesson: () => h(Lesson, { ...shared, courseId: 'course', moduleId: 'module', lessonId: 'lesson',
      route: { name: 'lesson', courseId: 'course', moduleId: 'module', lessonId: 'lesson' }, navSignal: null,
      chatOpen: false, setChatOpen: vi.fn(), scrollRef: { current: { key: '', top: 0 } }, readingScale: 1, setReadingScale: vi.fn() }),
    'coach project': () => h(CoachProject, { ...shared, projectId: 'project', route: { name: 'coachProject', projectId: 'project' } }),
    transcript: () => h(CoachTranscript, { ...shared, projectId: 'project', sessionId: 'session', route: { name: 'coachSession', projectId: 'project', sessionId: 'session' } })
  }
  it.each(Object.entries(screens))('%s retains the themed content surface until data arrives', async (_name, screen) => {
    await act(async () => root.render(screen()))
    const status = container.querySelector('[role="status"]')!
    expect(status.textContent).toBe('Loading…')
    // These are the same flex layout and themed background used by the loaded
    // pages; a bare .empty leaves the window's translucent background exposed.
    expect(status.closest('.content')?.parentElement?.className).toBe('body')
    expect(status.closest('.content-glass')).toBeNull()
  })
})
