import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CoachProject as Project } from '../src/core/types'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
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
    setDefaultCoachModel: vi.fn(async model => model), setDefaultCoachBackendModel: vi.fn(async model => model),
    onCoachChanged: () => () => {}, onCoachFilesChanged: () => () => {},
    updateCoachProject: vi.fn(async (_id, patch) => { project = { ...project, ...patch }; return project })
  }
  vi.stubGlobal('opencourse', api)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const renderSettings = async () => act(async () => root.render(h(Settings, {
  user: null, navigate: vi.fn(), onSession: vi.fn(), onSessionChanged: vi.fn(),
  route: { name: 'settings', from: { name: 'library' }, section: 'coach' }
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

it('hides Coach default model choices without an API key', async () => {
  api.listCoachModels = async () => ({ models: [] })
  api.listCoachBackendModels.mockResolvedValue({ models: [] })
  await renderSettings()
  expect(container.querySelector('.settings-default-coach-model')).toBeNull()
  expect(container.querySelector('.settings-default-coach-backend-model')).toBeNull()
  expect(container.textContent).toContain('Add an OpenAI API key')
})

it('offers all background models as shared defaults without a visibility checklist', async () => {
  await renderSettings()
  expect(container.textContent).toContain('Defaults for all coaches')
  expect(container.textContent).toContain('Every coach uses these settings when a new session starts.')
  expect(container.querySelector('.settings-coach-backend-models')).toBeNull()
  const background = container.querySelector<HTMLSelectElement>('.settings-default-coach-backend-model')!
  expect([...background.options].map(option => option.value)).toEqual(['gpt-6-luna', 'gpt-6-sol'])
  expect(background.disabled).toBe(false)
})
