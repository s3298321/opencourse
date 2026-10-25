import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CoachProject as Project } from '../src/core/types'
vi.mock('../src/renderer/components/CoachSession', () => ({ default: () => null }))
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
import CoachProject from '../src/renderer/routes/CoachProject'
import Settings from '../src/renderer/routes/Settings'

let root: Root, container: HTMLDivElement, project: Project, api: any
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  project = { id: 'coach', name: 'French', model: 'gpt-live-1', backendModel: 'gpt-6-luna', voice: 'cedar', instructions: 'Teach French', allowDelete: false, createdAt: 'now', updatedAt: 'now' }
  api = {
    getCoachProjectRunState: async () => ({ busy: false }), getCoachProject: async () => project,
    listCoachFiles: async () => [], listCoachSessions: async () => [],
    listCoachModels: async () => ({ models: [{ id: 'gpt-live-1', label: 'gpt-live-1' }] }),
    listCoachBackendModels: vi.fn(async () => ({ models: ['gpt-6-luna', 'gpt-6-sol'].map(id => ({ id, label: id })) })),
    getCoachAllowDelete: async () => false, onAIChanged: () => () => {},
    getDefaultCoachModel: async () => 'gpt-live-1', getDefaultCoachBackendModel: async () => 'gpt-6-luna',
    getDefaultCoachBackendReasoning: async () => null, setDefaultCoachBackendReasoning: vi.fn(async reasoning => reasoning),
    getCoachBackendModels: vi.fn(async () => null),
    setCoachBackendModels: vi.fn(async enabled => ({ enabled, defaultModel: enabled?.length ? enabled[0] : 'gpt-6-luna' })),
    setDefaultCoachModel: vi.fn(async model => model), setDefaultCoachBackendModel: vi.fn(async model => model),
    onCoachChanged: () => () => {}, onCoachFilesChanged: () => () => {},
    updateCoachProject: vi.fn(async (_id, patch) => { project = { ...project, ...patch }; return project })
  }
  vi.stubGlobal('opencourse', api)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async () => act(async () => root.render(h(CoachProject, { projectId: 'coach', user: null, navigate: vi.fn(), route: { name: 'coachProject', projectId: 'coach' } })))
it('keeps the loading indicator until both model catalogs settle', async () => {
  let resolveVoice!: (value: any) => void, resolveBackground!: (value: any) => void
  api.listCoachModels = () => new Promise(resolve => { resolveVoice = resolve })
  api.listCoachBackendModels = () => new Promise(resolve => { resolveBackground = resolve })
  await render()
  expect(container.querySelector('[role=status]')?.textContent).toContain('Loading Coach models')
  expect(container.querySelector('.coach-settings select')).toBeNull()
  await act(async () => resolveVoice({ models: [{ id: 'gpt-live-1', label: 'gpt-live-1' }] }))
  expect(container.querySelector('.coach-settings select')).toBeNull()
  await act(async () => resolveBackground({ models: [{ id: 'gpt-6-luna', label: 'gpt-6-luna' }] }))
  expect(container.querySelector('[role=status]')).toBeNull()
  expect(picker().value).toBe('gpt-6-luna')
})
it('finishes loading after an error and lets the user retry', async () => {
  api.listCoachModels = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ models: [{ id: 'gpt-live-1', label: 'gpt-live-1' }] })
  await render()
  expect(container.textContent).not.toContain('Loading Coach models')
  expect(container.textContent).toContain('Couldn’t load all models')
  await act(async () => container.querySelector<HTMLButtonElement>('.coach-models-status button')!.click())
  expect(container.textContent).not.toContain('Couldn’t load all models')
  expect(picker().value).toBe('gpt-6-luna')
})
it('saves per-coach reasoning and offers only supported levels', async () => {
  project.backendModel = 'gpt-6.1-sol'
  await render()
  const reasoning = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('Background reasoning'))!.querySelector('select')!
  expect([...reasoning.options].map(option => option.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh'])
  await act(async () => { reasoning.value = 'high'; reasoning.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.updateCoachProject).toHaveBeenCalledWith('coach', { backendReasoning: 'high' })
  expect(reasoning.value).toBe('high')
  await act(async () => { reasoning.value = ''; reasoning.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.updateCoachProject).toHaveBeenLastCalledWith('coach', { backendReasoning: null })
})
function picker(): HTMLSelectElement {
  return [...container.querySelectorAll('label')].find(l => l.textContent?.includes('Background model'))!.querySelector('select')!
}
it('saves a per-coach background choice without changing the voice model', async () => {
  await render()
  expect(picker().value).toBe('gpt-6-luna')
  await act(async () => { picker().value = 'gpt-6-sol'; picker().dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.updateCoachProject).toHaveBeenCalledWith('coach', { backendModel: 'gpt-6-sol' })
  expect(picker().value).toBe('gpt-6-sol')
  expect(project.model).toBe('gpt-live-1')
})
it('keeps the saved selection visible when the model list is unavailable', async () => {
  project.backendModel = 'gpt-5-mini'
  api.listCoachBackendModels.mockRejectedValue(new Error('offline'))
  await render()
  expect(picker().value).toBe('gpt-5-mini')
  expect([...picker().options].map(o => o.value)).toEqual(['gpt-5-mini'])
  expect(picker().disabled).toBe(true)
})

const renderSettings = async () => act(async () => root.render(h(Settings, {
  user: null, navigate: vi.fn(), onSession: vi.fn(), onSessionChanged: vi.fn(),
  route: { name: 'settings', from: { name: 'coach' }, section: 'coach' }
})))
it('saves default reasoning and keeps the saved value when an update fails', async () => {
  await renderSettings()
  const reasoning = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-reasoning')!
  await act(async () => { reasoning.value = 'high'; reasoning.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.setDefaultCoachBackendReasoning).toHaveBeenCalledWith('high')
  expect(reasoning.value).toBe('high')
  api.setDefaultCoachBackendReasoning.mockRejectedValue(new Error('Could not save reasoning'))
  await act(async () => { reasoning.value = 'low'; reasoning.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(reasoning.value).toBe('high')
  expect(reasoning.disabled).toBe(false)
  expect(container.textContent).toContain('Could not save reasoning')
})
it('resets the displayed default reasoning when a new model does not support it', async () => {
  api.getDefaultCoachBackendReasoning = async () => 'none'
  api.listCoachBackendModels.mockResolvedValue({ models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-4o'].map(id => ({ id, label: id })) })
  await renderSettings()
  const model = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!
  const reasoning = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-reasoning')!
  expect(reasoning.value).toBe('none')
  await act(async () => { model.value = 'gpt-6.1-sol'; model.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(reasoning.value).toBe('')
  expect([...reasoning.options].map(option => option.value)).not.toContain('none')
  await act(async () => { model.value = 'gpt-4o'; model.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(reasoning.disabled).toBe(true)
})
it('saves voice and background defaults independently in Settings → Coach', async () => {
  await renderSettings()
  const voice = container.querySelector<HTMLSelectElement>('.settings-default-coach-model')!
  const background = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!
  expect(voice.value).toBe('gpt-live-1')
  expect(background.value).toBe('gpt-6-luna')
  await act(async () => { background.value = 'gpt-6-sol'; background.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.setDefaultCoachBackendModel).toHaveBeenCalledWith('gpt-6-sol')
  expect(api.setDefaultCoachModel).not.toHaveBeenCalled()
  expect(background.value).toBe('gpt-6-sol')
  await act(async () => voice.dispatchEvent(new Event('change', { bubbles: true })))
  expect(api.setDefaultCoachModel).toHaveBeenCalledWith('gpt-live-1')
  expect(api.updateCoachProject).not.toHaveBeenCalled()
})
it('keeps the previous background default if saving fails', async () => {
  api.setDefaultCoachBackendModel.mockRejectedValue(new Error('Could not save preferences'))
  await renderSettings()
  const background = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!
  await act(async () => { background.value = 'gpt-6-sol'; background.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(background.value).toBe('gpt-6-luna')
  expect(background.disabled).toBe(false)
  expect(container.querySelector('.import-note.error')?.textContent).toBe('Could not save preferences')
})

it('hides Coach default and per-coach model choices without an API key', async () => {
  api.listCoachModels = async () => ({ models: [] })
  api.listCoachBackendModels.mockResolvedValue({ models: [] })
  await renderSettings()
  expect(container.querySelector('.settings-default-coach-model')).toBeNull()
  expect(container.querySelector('.settings-default-coach-backend-model')).toBeNull()
  expect(container.textContent).toContain('Add an OpenAI API key')
  await render()
  expect(container.textContent).not.toContain('Voice model')
  expect(container.textContent).not.toContain('Background model')
})

it('filters background choices and moves a hidden default to a selected model', async () => {
  await renderSettings()
  const box = container.querySelector<HTMLInputElement>('.settings-coach-backend-models input[type=checkbox]')!
  expect(box.checked).toBe(true)
  await act(async () => box.click())
  expect(api.setCoachBackendModels).toHaveBeenCalledWith(['gpt-6-sol'])
  const background = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!
  expect([...background.options].map(option => option.value)).toEqual(['gpt-6-sol'])
  expect(background.value).toBe('gpt-6-sol')
  expect(api.setDefaultCoachModel).not.toHaveBeenCalled()
})

it('supports empty selections and restores automatically included models with Select all', async () => {
  await renderSettings()
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-coach-backend-models .settings-models-unselect-all')!.click())
  expect(api.setCoachBackendModels).toHaveBeenLastCalledWith([])
  expect(container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!.disabled).toBe(true)
  expect([...container.querySelectorAll<HTMLInputElement>('.settings-coach-backend-models input')].every(box => !box.checked)).toBe(true)
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-coach-backend-models .settings-models-select-all')!.click())
  expect(api.setCoachBackendModels).toHaveBeenLastCalledWith(null)
  expect(container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!.disabled).toBe(false)
})

it('loads saved visibility and keeps it intact when a change fails', async () => {
  api.getCoachBackendModels.mockResolvedValue(['gpt-6-sol'])
  api.getDefaultCoachBackendModel = async () => 'gpt-6-sol'
  api.setCoachBackendModels.mockRejectedValue(new Error('Could not save models'))
  await renderSettings()
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.settings-coach-backend-models input')]
  expect(boxes.map(box => box.checked)).toEqual([false, true])
  await act(async () => boxes[0].click())
  expect(boxes.map(box => box.checked)).toEqual([false, true])
  expect(container.textContent).toContain('Could not save models')
})

it('refreshes an existing coach’s choices without changing its saved model', async () => {
  let changed!: () => void
  api.onAIChanged = (callback: () => void) => { changed = callback; return () => {} }
  await render()
  api.listCoachBackendModels.mockResolvedValue({ models: [{ id: 'gpt-6-sol', label: 'gpt-6-sol' }] })
  await act(async () => changed())
  expect(picker().value).toBe('gpt-6-luna')
  expect([...picker().options].filter(option => !option.disabled).map(option => option.value)).toEqual(['gpt-6-sol'])
  expect(api.updateCoachProject).not.toHaveBeenCalled()
})
