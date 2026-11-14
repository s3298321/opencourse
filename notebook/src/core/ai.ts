import type { AIProfile, AIProvider, AIScope, AISettings, ChatDefaults, ChatModel, Preferences } from './types'
import { isReasoningEffort, reasoningEffortsFor } from './sidechat/models'
import { defaultChatModel } from './sidechat/models'

export function isAIProvider(value: unknown): value is AIProvider { return value === 'apiKey' || value === 'chatgpt' }
export function isAIScope(value: unknown): value is AIScope { return value === 'chat' || value === 'project' || value === 'authoring' }
export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value)
}
export function emptyProfile(): AIProfile { return { enabledModels: null, defaultModel: null, defaultReasoning: null } }
export function normalizeProfile(raw: unknown): AIProfile {
  const p = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const ids = Array.isArray(p.enabledModels) ? [...new Set(p.enabledModels.filter(validModelId))].slice(0, 200) : null
  const model = validModelId(p.defaultModel) ? p.defaultModel : null
  return { enabledModels: ids, defaultModel: model,
    defaultReasoning: isReasoningEffort(p.defaultReasoning) ? p.defaultReasoning : null }
}
export function aiSettings(preferences: Preferences): AISettings {
  const legacy: AIProfile = {
    enabledModels: preferences.chatModels ?? null,
    defaultModel: defaultChatModel(preferences.chatModels ?? null, preferences.defaultChatModel),
    defaultReasoning: preferences.defaultChatReasoning ?? null
  }
  const scope = (name: AIScope): AISettings[AIScope] => {
    const raw = preferences.ai?.[name]
    return { provider: isAIProvider(raw?.provider) ? raw.provider : 'apiKey', profiles: {
      apiKey: raw?.profiles?.apiKey ? normalizeProfile(raw.profiles.apiKey) : structuredClone(legacy),
      chatgpt: normalizeProfile(raw?.profiles?.chatgpt)
    } }
  }
  const chat = scope('chat')
  return { chat, project: scope('project'), authoring: preferences.ai?.authoring ? scope('authoring') : structuredClone(chat) }
}
export function modelReasoning(model: string, catalog: readonly ChatModel[]): ReturnType<typeof reasoningEffortsFor> {
  return catalog.find(m => m.id === model)?.reasoningEfforts ?? reasoningEffortsFor(model)
}
export function profileDefaults(profile: AIProfile): ChatDefaults {
  return { model: profile.defaultModel ?? '', reasoning: profile.defaultReasoning }
}
export function effectiveConversation<T extends ChatDefaults & { provider?: AIProvider }>(
  chat: T, provider: AIProvider, profile: AIProfile
): T & { provider: AIProvider } {
  const reset = !chat.model || (chat.provider ?? 'apiKey') !== provider ||
    (profile.enabledModels !== null && !profile.enabledModels.includes(chat.model))
  return { ...chat, ...(reset ? profileDefaults(profile) : {}), provider }
}
export function permittedModels(models: readonly ChatModel[], profile: AIProfile): ChatModel[] {
  return models.filter(m => profile.enabledModels === null || profile.enabledModels.includes(m.id))
}
