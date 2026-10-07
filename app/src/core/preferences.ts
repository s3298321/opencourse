/**
 * A user's preferences.json, read the way every JSON file here is read: as
 * whatever can still be made sense of. A hand-edited file with a typo costs the
 * setting it broke, never the app.
 */
import { defaultChatModel, isChatModelId, isReasoningEffort, reasoningEffortsFor } from './sidechat/models'
import { isRealtimeModelId } from './coach/models'
import type { ChatDefaults, Preferences } from './types'
import { aiSettings, isAIProvider, validModelId } from './ai'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** More than any key reaches, and few enough that a corrupt file stays small. */
export const MAX_CHAT_MODELS = 200

/**
 * Chat model ids, deduplicated and in their given order. Null means there is
 * no choice to keep - including an empty list, because a picker with nothing
 * in it is a chat nobody can use, and that is not a choice anyone made.
 */
export function normalizeChatModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string' || id.length > 100 || !isChatModelId(id) || seen.has(id)) continue
    seen.add(id)
    if (seen.size >= MAX_CHAT_MODELS) break
  }
  return seen.size ? [...seen] : null
}

export function normalizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object') return {}
  const chatModels = normalizeChatModels((raw as Record<string, unknown>)['chatModels'])
  const projectEditor = (raw as Record<string, unknown>)['projectEditor']
  const values = raw as Record<string, unknown>
  const model = values['defaultChatModel']
  const preferred = typeof model === 'string' && model.length <= 100 && isChatModelId(model) &&
    (!chatModels || chatModels.includes(model)) ? model : undefined
  const reasoning = values['defaultChatReasoning']
  const coachModel = values['defaultCoachModel']
  // Only a literal true turns search on. It costs money on every use, so a
  // hand-edited "yes" or 1 reads as the default - off - rather than as consent.
  const webSearch = (raw as Record<string, unknown>)['webSearch'] === true
  // A theme is named by its app-local UUID; anything else is a hand-edit that
  // means nothing, and reads as "no theme" rather than as an error.
  const theme = values['theme']
  const kept: Preferences = {
    ...(chatModels ? { chatModels } : {}),
    ...(preferred ? { defaultChatModel: preferred } : {}),
    ...(isReasoningEffort(reasoning) && reasoningEffortsFor(defaultChatModel(chatModels, preferred)).includes(reasoning)
      ? { defaultChatReasoning: reasoning } : {}),
    ...(typeof coachModel === 'string' && coachModel.length <= 100 && isRealtimeModelId(coachModel)
      ? { defaultCoachModel: coachModel } : {}),
    ...(['zed', 'vscode', 'cursor', 'sublime'].includes(String(projectEditor)) ? { projectEditor: String(projectEditor) } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(typeof theme === 'string' && UUID.test(theme) ? { theme } : {}),
    ...(typeof values['activeServer'] === 'string' && UUID.test(values['activeServer']) ? { activeServer: values['activeServer'] } : {})
  }
  if (values['ai'] && typeof values['ai'] === 'object') kept.ai = aiSettings({ ...kept, ai: values['ai'] as Preferences['ai'] })
  const title = values['titleGeneration'] as Partial<NonNullable<Preferences['titleGeneration']>> | undefined
  if (title && isAIProvider(title.provider) && validModelId(title.model) && (title.reasoning === null || isReasoningEffort(title.reasoning))) {
    kept.titleGeneration = { provider: title.provider, model: title.model, reasoning: title.reasoning }
  }
  return kept
}

/** Apply the user's defaults once, when a lesson or project chat is created. */
export function newChatDefaults(preferences: Preferences, override?: string): ChatDefaults {
  const model = override && isChatModelId(override) ? override :
    defaultChatModel(preferences.chatModels ?? null, preferences.defaultChatModel)
  const reasoning = preferences.defaultChatReasoning
  return { model, reasoning: reasoning && reasoningEffortsFor(model).includes(reasoning) ? reasoning : null }
}
