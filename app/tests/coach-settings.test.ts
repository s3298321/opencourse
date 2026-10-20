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
    setDefaultCoachModel: vi.fn(async model => model), setDefaultCoachBackendModel: vi.fn(async model => model),
    onCoachChanged: () => () => {}, onCoachFilesChanged: () => () => {},
    updateCoachProject: vi.fn(async (_id, patch) => { project = { ...project, ...patch }; return project })
  }
  vi.stubGlobal('opencourse', api)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async () => act(async () => root.render(h(CoachProject, { projectId: 'coach', user: null, navigate: vi.fn(), route: { name: 'coachProject', projectId: 'coach' } })))
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
  expect([...picker().options].map(o => o.value)).toContain('gpt-6-luna')
})

const renderSettings = async () => act(async () => root.render(h(Settings, {
  user: null, navigate: vi.fn(), onSession: vi.fn(), onSessionChanged: vi.fn(),
  route: { name: 'settings', from: { name: 'coach' }, section: 'coach' }
})))
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
