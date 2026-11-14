import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CoachProject as Project } from '../src/core/types'
import { VOICES } from '../src/core/coach/models'
import { DEFAULT_COACH_PROMPTS } from '../src/core/coach/prompt-defaults'
const preview = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(async () => {}), changed: undefined as ((state: string, error?: string) => void) | undefined }))
vi.mock('../src/renderer/coach/voice-preview', () => ({ VoicePreview: class {
  constructor(changed: typeof preview.changed) { preview.changed = changed }
  start = preview.start
  stop = preview.stop
} }))
vi.mock('../src/renderer/components/TitleBar', () => ({ default: () => null }))
import Settings from '../src/renderer/routes/Settings'

let root: Root, container: HTMLDivElement, project: Project, api: any
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  project = { id: 'coach', name: 'French', model: 'gpt-live-1', backendModel: 'gpt-6-luna', voice: 'cedar', instructions: 'Teach French', allowDelete: false, createdAt: 'now', updatedAt: 'now' }
  api = {
    getDefaultCoachPrompts: vi.fn(async () => ({ ...DEFAULT_COACH_PROMPTS })),
    setDefaultCoachPrompts: vi.fn(async prompts => prompts),
    getCoachProjectRunState: async () => ({ busy: false }), getCoachProject: async () => project,
    listCoachFiles: async () => [], listCoachSessions: async () => [],
    listCoachModels: async () => ({ models: [{ id: 'gpt-live-1', label: 'gpt-live-1' }] }),
    listCoachBackendModels: vi.fn(async () => ({ models: ['gpt-6-luna', 'gpt-6-sol'].map(id => ({ id, label: id })) })),
    getCoachAllowDelete: async () => false, onAIChanged: () => () => {},
    getDefaultCoachModel: async () => 'gpt-live-1', getDefaultCoachBackendModel: async () => 'gpt-6-luna',
    getDefaultCoachVoice: async () => 'marin', setDefaultCoachVoice: vi.fn(async voice => voice),
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
it('loads and saves the default voice independently, retaining it when saving fails', async () => {
  api.getDefaultCoachVoice = async () => 'echo'
  await renderSettings()
  const voice = container.querySelector<HTMLSelectElement>('.settings-default-coach-voice')!
  expect(voice.value).toBe('echo')
  expect(voice.labels?.[0]?.textContent).toContain('Default voice')
  await act(async () => { voice.value = 'cedar'; voice.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.setDefaultCoachVoice).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-save-coach-voice')!.click())
  expect(api.setDefaultCoachVoice).toHaveBeenCalledWith('cedar')
  expect(voice.value).toBe('cedar')
  expect(api.setDefaultCoachModel).not.toHaveBeenCalled()
  expect(api.updateCoachProject).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Coach settings saved.')
  api.setDefaultCoachVoice.mockRejectedValueOnce(new Error('Could not save voice'))
  await act(async () => { voice.value = 'shimmer'; voice.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-save-coach-voice')!.click())
  expect(voice.value).toBe('shimmer')
  expect(container.textContent).toContain('Saved voice: Cedar')
  expect(voice.disabled).toBe(false)
  expect(container.textContent).toContain('Could not save voice')
})
it('offers all 31 voices and previews the candidate without saving it', async () => {
  await renderSettings()
  const voice = container.querySelector<HTMLSelectElement>('.settings-default-coach-voice')!
  expect([...voice.options].map(option => option.value)).toEqual(VOICES)
  expect(voice.options.length).toBe(31)
  expect([...voice.options].map(option => option.label)).toEqual(expect.arrayContaining([
    'Brise · French', 'Sillage · French', 'Marin · English', 'Bossa · Brazilian Portuguese',
    'Flitz · German', 'Nira · Hindi', 'Harema · Japanese', 'Noeul · Korean'
  ]))
  await act(async () => { voice.value = 'brise'; voice.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-preview-coach-voice')!.click())
  expect(preview.start).toHaveBeenCalledWith('brise')
  expect(api.setDefaultCoachVoice).not.toHaveBeenCalled()
  await act(async () => preview.changed?.('playing'))
  expect(container.textContent).toContain('Stop preview')
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-preview-coach-voice')!.click())
  expect(preview.stop).toHaveBeenCalled()
  await act(async () => preview.changed?.('idle', 'Preview unavailable'))
  expect(container.textContent).toContain('Preview unavailable')
  expect(container.textContent).toContain('Saved voice: Marin')
})
it('stops a preview when leaving the Coach settings category', async () => {
  await renderSettings()
  await act(async () => container.querySelector<HTMLButtonElement>('.settings-preview-coach-voice')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-settings-category="profile"]')!.click())
  expect(preview.stop).toHaveBeenCalledOnce()
})
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

const editPrompt = async (key: string, value: string) => act(async () => {
  const field = container.querySelector<HTMLTextAreaElement>(`[data-coach-prompt="${key}"]`)!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

it('edits all five prompts and saves them explicitly for new coaches only', async () => {
  await renderSettings()
  expect(container.querySelectorAll('[data-coach-prompt]')).toHaveLength(5)
  const save = container.querySelector<HTMLButtonElement>('.settings-save-coach-prompts')!
  expect(save.disabled).toBe(true)
  await editPrompt('firstConversation', 'Ask about their goals, one question at a time.')
  expect(api.setDefaultCoachPrompts).not.toHaveBeenCalled()
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(api.setDefaultCoachPrompts).toHaveBeenCalledWith({ ...DEFAULT_COACH_PROMPTS, firstConversation: 'Ask about their goals, one question at a time.' })
  expect(api.updateCoachProject).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Prompts saved for new coaches.')
  expect(save.disabled).toBe(true)
})

it('retains prompt drafts on save failure and supports discard and staged restore', async () => {
  api.getDefaultCoachPrompts.mockResolvedValue({ ...DEFAULT_COACH_PROMPTS, voice: 'Saved voice instructions' })
  await renderSettings()
  const section = container.querySelector('.settings-coach-prompts')!
  const button = (text: string) => [...section.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
  await editPrompt('voice', 'Draft voice instructions')
  api.setDefaultCoachPrompts.mockRejectedValueOnce(new Error('Could not save prompts'))
  await act(async () => button('Save prompts').click())
  const field = () => container.querySelector<HTMLTextAreaElement>('[data-coach-prompt="voice"]')!
  expect(field().value).toBe('Draft voice instructions')
  expect(section.textContent).toContain('Could not save prompts')
  await act(async () => button('Discard changes').click())
  expect(field().value).toBe('Saved voice instructions')
  await act(async () => field().closest('.settings-coach-prompt')!.querySelector<HTMLButtonElement>('.action-button')!.click())
  expect(field().value).toBe(DEFAULT_COACH_PROMPTS.voice)
  expect(api.setDefaultCoachPrompts).toHaveBeenCalledTimes(1)
  await editPrompt('shared', '  ')
  expect(button('Save prompts').disabled).toBe(true)
})

it('allows editing prompts without an API connection', async () => {
  api.listCoachModels = async () => ({ models: [] })
  api.listCoachBackendModels.mockResolvedValue({ models: [] })
  await renderSettings()
  expect(container.querySelectorAll('[data-coach-prompt]')).toHaveLength(5)
  await editPrompt('backend', 'Keep concise learning notes.')
  expect(container.querySelector<HTMLButtonElement>('.settings-save-coach-prompts')!.disabled).toBe(false)
})
