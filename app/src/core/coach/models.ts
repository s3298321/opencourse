/** Supported conversational Live models; transcription models are never coaches. */
import type { CoachModel, ReasoningEffort } from '../types'
import { filterChatModels, isChatModelId, isReasoningEffort, reasoningEffortsFor } from '../sidechat/models'

/** Live delegation accepts the existing effort enum, with model-specific restrictions. */
export function backendReasoningEffortsFor(model: string): readonly ReasoningEffort[] {
  const levels = reasoningEffortsFor(model)
  return /^gpt-(?:6\.1-sol|6-astra)(?:-|$)/.test(model) ? levels.filter(level => level !== 'none' && level !== 'minimal') : levels
}

export function normalizeBackendReasoning(model: string, value: unknown): ReasoningEffort | null {
  return isReasoningEffort(value) && backendReasoningEffortsFor(model).includes(value) ? value : null
}

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
/** Preview languages for GPT-Live voices: https://developers.openai.com/api/docs/guides/live-conversations#voice-options */
export const VOICE_LANGUAGES = {
  alloy: 'English', ash: 'English', ballad: 'English', beacon: 'English',
  bossa: 'Brazilian Portuguese', brise: 'French', cedar: 'English', cinder: 'English',
  coral: 'English', delta: 'English', echo: 'English', flitz: 'German',
  gleam: 'English', harema: 'Japanese', juni: 'German', marin: 'English',
  meridian: 'English', nira: 'Hindi', noeul: 'Korean', nuri: 'German',
  quartz: 'English', ripple: 'English', sage: 'English', shida: 'Japanese',
  shimmer: 'English', sillage: 'French', stone: 'English', tempo: 'Brazilian Portuguese',
  verse: 'English', vesper: 'English', willow: 'English'
} as const
export type CoachVoice = keyof typeof VOICE_LANGUAGES
export const VOICES: readonly string[] = Object.keys(VOICE_LANGUAGES)
export function isCoachVoice(voice: string): voice is CoachVoice {
  return Object.hasOwn(VOICE_LANGUAGES, voice)
}
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
