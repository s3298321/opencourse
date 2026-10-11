import { describe, expect, it } from 'vitest'
import { initialNavigation, navigateWorkspace, screenKey, switchWorkspace } from '../src/renderer/workspaces'
import type { Screen } from '../src/renderer/routes'

describe('workspace navigation', () => {
  const lesson: Screen = { name: 'lesson', courseId: 'course', moduleId: 'module', lessonId: 'lesson' }
  it('lazily opens each home and retains both current screens', () => {
    let state = initialNavigation()
    expect(state.courses).toBeNull()
    state = switchWorkspace(state, 'courses')
    expect(state.route).toEqual({ name: 'library' })
    state = navigateWorkspace(state, lesson)
    state = switchWorkspace(state, 'coach')
    expect(state.route).toEqual({ name: 'coach' })
    const coach: Screen = { name: 'coachSession', projectId: 'project', sessionId: 'session' }
    state = navigateWorkspace(state, coach)
    state = switchWorkspace(state, 'courses')
    expect(state.route).toBe(lesson)
    expect(switchWorkspace(state, 'coach').route).toBe(coach)
    expect(switchWorkspace(state, 'courses')).toBe(state)
  })
  it('dismisses overlays without overwriting the parked screen', () => {
    let state = navigateWorkspace(initialNavigation(), lesson)
    state = navigateWorkspace(state, { name: 'settings', from: lesson, section: 'about' })
    expect(state.courses).toBe(lesson)
    expect(switchWorkspace(state, 'courses').route).toBe(lesson)
    state = switchWorkspace(state, 'coach')
    expect(switchWorkspace(state, 'courses').route).toBe(lesson)
  })
  it('explicit home navigation replaces the saved destination, and the picker clears both', () => {
    let state = navigateWorkspace(initialNavigation(), lesson)
    state = navigateWorkspace(state, { name: 'catalog', serverId: 'server' })
    state = switchWorkspace(state, 'coach')
    expect(switchWorkspace(state, 'courses').route).toEqual({ name: 'catalog', serverId: 'server' })
    expect(navigateWorkspace(state, { name: 'users' })).toEqual(initialNavigation())
  })
  it('keeps lesson and library instances for prop navigation but replaces distinct editors', () => {
    expect(screenKey(lesson)).toBe(screenKey({ ...lesson, lessonId: 'next' } as Screen))
    expect(screenKey({ name: 'library', source: 'local' })).toBe(screenKey({ name: 'library', source: 'server' }))
    expect(screenKey({ name: 'catalog', serverId: 'one' })).not.toBe(screenKey({ name: 'catalog', serverId: 'two' }))
    expect(screenKey({ name: 'courseEditor', courseId: 'one' })).not.toBe(screenKey({ name: 'courseEditor', courseId: 'two' }))
  })
  it('parks PDFs alongside courses and Coach, including under Settings, and clears them on user change', () => {
    let state = navigateWorkspace(initialNavigation(), lesson)
    state = switchWorkspace(state, 'documents')
    expect(state.route).toEqual({ name: 'documents' })
    const pdf: Screen = { name: 'document', documentId: 'pdf' }
    state = navigateWorkspace(state, pdf)
    state = navigateWorkspace(state, { name: 'settings', from: pdf })
    expect(switchWorkspace(state, 'documents').route).toBe(pdf)
    state = switchWorkspace(state, 'coach')
    expect(switchWorkspace(state, 'courses').route).toBe(lesson)
    expect(switchWorkspace(state, 'documents').route).toBe(pdf)
    expect(screenKey(pdf)).not.toBe(screenKey({ name: 'document', documentId: 'other' }))
    expect(navigateWorkspace(state, { name: 'users' }).documents).toBeNull()
  })
  it('retains just the current course’s visited reader screens and clears them on departure', () => {
    const notebook: Screen = { name: 'notebook', courseId: 'course' }
    let state = navigateWorkspace(initialNavigation(), lesson)
    state = navigateWorkspace(state, notebook)
    expect(state.reader).toEqual({ courseId: 'course', lesson, notebook })
    state = switchWorkspace(state, 'coach')
    expect(state.reader?.notebook).toBe(notebook)
    state = navigateWorkspace(state, { name: 'settings', from: notebook })
    expect(state.reader?.lesson).toBe(lesson)
    state = navigateWorkspace(state, { name: 'lesson', courseId: 'other', moduleId: 'm', lessonId: 'l' })
    expect(state.reader?.notebook).toBeUndefined()
    expect(state.reader?.courseId).toBe('other')
    state = navigateWorkspace(state, { name: 'library' })
    expect(state.reader).toBeNull()
    expect(navigateWorkspace(state, { name: 'users' }).reader).toBeNull()
  })

})
