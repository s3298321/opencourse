/** Supported conversational Live models; transcription models are never coaches. */
import type { CoachModel } from '../types'
import { filterChatModels, isChatModelId } from '../sidechat/models'

export const DEFAULT_MODEL = 'gpt-live-1'
export const BACKEND_MODEL = 'gpt-6-luna'
export const BACKEND_MODELS: readonly CoachModel[] = [
  { id: BACKEND_MODEL, label: BACKEND_MODEL },
  { id: 'gpt-6-sol', label: 'gpt-6-sol' }
]

/** General Responses models with function tools; exclude specialized variants. */
export function isBackendModelId(id: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(id) && isChatModelId(id) &&
    /^(?:gpt-(?:[5-9]\d*|4\.1|4o)(?:[.-]|$)|o[34](?:[.-]|$))/.test(id) &&
    !/(?:-chat|-pro|-deep-research)(?:-|$)/.test(id)
}

export function filterBackendModels(ids: readonly string[]): CoachModel[] {
  return filterChatModels(ids.filter(isBackendModelId)).sort((a, b) =>
    a.id === BACKEND_MODEL ? -1 : b.id === BACKEND_MODEL ? 1 : a.id.localeCompare(b.id))
}
// Add snapshots only after verifying their Live protocol compatibility.
export const LIVE_MODELS: readonly CoachModel[] = [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL }]
export const WEB_SEARCH_MODEL = 'gpt-5-mini'
export const VOICES: readonly string[] = ['marin', 'cedar', 'alloy', 'echo', 'shimmer']
export const DEFAULT_VOICE = 'marin'

export function isLiveModelId(id: string): boolean {
  return LIVE_MODELS.some(model => model.id === id)
}

/** Upgrade configuration only. Historical session model names stay untouched. */
export function migrateCoachModel(id: string): string {
  return !id || (id.includes('realtime') && !id.includes('transcribe') && !id.includes('translate')) ? DEFAULT_MODEL : id
}

export function filterLiveModels(ids: readonly string[]): CoachModel[] {
  return LIVE_MODELS.filter(model => ids.includes(model.id)).map(model => ({ ...model }))
}
