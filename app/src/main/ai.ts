import { createHash } from 'node:crypto'
import { normalizeModelContext } from '../core/ai-context'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { aiSettings, effectiveConversation, isAIProvider, isAIScope, modelReasoning, normalizeProfile, permittedModels, profileDefaults, validModelId } from '../core/ai'
import type { AIConnection, AIModelSettings, AIProfile, AIProvider, AIScope, ChatDefaults, ChatModel, ModelContextMetadata, TitleGenerationConfig, TitleGenerationSettings } from '../core/types'
import { filterChatModels, isChatModelId, isReasoningEffort } from '../core/sidechat/models'
import { readKey } from './coachkey'
import { listChatModels, listSubscriptionModels } from './openai'
import { readPreferences, writePreferences } from './preferences'
import { currentUserId, requireUser } from './users'
import { subscriptionAccessToken, subscriptionIdentity } from './subscription'
import { userDir } from './paths'

export const aiEvents = new EventEmitter()
type Catalog = { models: ChatModel[]; source: 'api' | 'cache' | 'fallback'; error?: string }
const catalogs = new Map<string, Catalog>()
const staleCatalogs = new Set<string>()
let revision = 0
export function notifyAIChanged(): void { revision++; aiEvents.emit('changed') }
export function notifyAIConnectionChanged(): void {
  const owner = currentUserId()
  if (owner) for (const id of catalogs.keys()) if (id.startsWith(`${owner}:`)) staleCatalogs.add(id)
  notifyAIChanged()
}
export function connectionStatus(provider: AIProvider): AIConnection {
  if (provider === 'apiKey') return { provider, ready: Boolean(readKey()), ...(!readKey() ? { message: 'Add an OpenAI API key in Settings.' } : {}) }
  const account = subscriptionIdentity()
  return { provider, ready: account?.ready === true, account: account?.label, volatile: account?.volatile,
    ...(!account?.ready ? { message: 'Connect your ChatGPT subscription in Settings.' } : {}) }
}
function identity(provider: AIProvider): string {
  return `${requireUser()}:${provider}:${provider === 'apiKey'
    ? createHash('sha256').update(readKey()).digest('hex') : subscriptionIdentity()?.id ?? 'disconnected'}`
}
function catalogFile(id: string): string { return join(userDir(requireUser()), 'connections', 'models', `${createHash('sha256').update(id).digest('hex')}.json`) }
function cachedCatalog(id: string): Catalog | undefined {
  const memory = catalogs.get(id)
  if (memory) return memory
  try {
    const raw = JSON.parse(readFileSync(catalogFile(id), 'utf8')) as { models: ChatModel[] }
    if (!Array.isArray(raw.models) || raw.models.length > 200) return undefined
    const models = raw.models.filter(m => validModelId(m.id) && typeof m.label === 'string').map(m => ({ id: m.id, label: m.label.slice(0, 200),
      ...normalizeModelContext(m),
      ...(Array.isArray(m.reasoningEfforts) ? { reasoningEfforts: m.reasoningEfforts.filter(isReasoningEffort) } : {}) }))
    const result: Catalog = { models, source: 'cache' }
    catalogs.set(id, result); return result
  } catch { return undefined }
}
function storeCatalog(id: string, catalog: Catalog): void {
  catalogs.set(id, catalog)
  staleCatalogs.delete(id)
  const target = catalogFile(id)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ models: catalog.models }), { mode: 0o600 })
  renameSync(temporary, target)
}
export async function modelCatalog(provider: AIProvider, refresh = false): Promise<Catalog> {
  const owner = requireUser(), id = identity(provider)
  const cached = cachedCatalog(id)
  if (!refresh && cached?.source === 'api' && !staleCatalogs.has(id)) return cached
  if (!connectionStatus(provider).ready) return provider === 'apiKey'
    ? listChatModels('') : { models: [], source: 'fallback' }
  try {
    const models = provider === 'apiKey' ? (await listChatModels(readKey())) : {
      models: await listSubscriptionModels(await subscriptionAccessToken(subscriptionIdentity()?.id)), source: 'api' as const }
    if (currentUserId() !== owner || identity(provider) !== id) throw new Error('The AI connection changed. Try again.')
    if (models.source === 'api') storeCatalog(id, models)
    else if (cached) return { ...cached, source: 'cache', error: models.error }
    return models
  } catch (error) {
    if (currentUserId() !== owner || identity(provider) !== id) throw new Error('The AI connection changed. Try again.')
    return { models: cached?.models ?? [], source: cached ? 'cache' : 'fallback', error: (error as Error).message }
  }
}
export function profileFor(scope: AIScope, provider?: AIProvider): { provider: AIProvider; profile: AIProfile } {
  const settings = aiSettings(readPreferences())[scope]
  const selected = provider ?? settings.provider
  const profile = settings.profiles[selected]
  const catalog = cachedCatalog(identity(selected))
  return { provider: selected, profile: { ...profile,
    defaultModel: profile.defaultModel ?? permittedModels(catalog?.models ?? [], profile)[0]?.id ?? null } }
}
function checkScope(scope: unknown): asserts scope is AIScope { if (!isAIScope(scope)) throw new Error('Invalid AI feature.') }
function checkProvider(provider: unknown): asserts provider is AIProvider { if (!isAIProvider(provider)) throw new Error('Invalid AI connection.') }
export async function getAIModelSettings(scope: AIScope, provider?: AIProvider, refresh = false): Promise<AIModelSettings> {
  checkScope(scope)
  const chosen = provider ?? aiSettings(readPreferences())[scope].provider
  checkProvider(chosen)
  const owner = requireUser(), catalog = await modelCatalog(chosen, refresh)
  if (currentUserId() !== owner) throw new Error('The local user changed.')
  const preferences = readPreferences(), all = aiSettings(preferences)
  // Initialize each subscription profile once, retaining the server's visible order.
  if (chosen === 'chatgpt' && catalog.models.length) {
    let initialized = false
    for (const target of ['chat', 'project', 'authoring'] as const) {
      const profile = all[target].profiles.chatgpt
      if (profile.defaultModel === null && profile.enabledModels === null) { profile.defaultModel = catalog.models[0].id; initialized = true }
    }
    if (initialized) writePreferences({ ...preferences, ai: all })
  }
  const settings = all[scope]
  return { scope, provider: chosen, selectedProvider: settings.provider, profile: profileFor(scope, chosen).profile,
    ...catalog, connection: connectionStatus(chosen), webSearch: scope === 'chat' && readPreferences().webSearch === true }
}
export function setAIProvider(scope: AIScope, provider: AIProvider): void {
  checkScope(scope); checkProvider(provider)
  const preferences = readPreferences(), settings = aiSettings(preferences)
  settings[scope].provider = provider
  writePreferences({ ...preferences, ai: settings }); notifyAIChanged()
}
export async function setAIProfile(scope: AIScope, provider: AIProvider, value: AIProfile): Promise<void> {
  checkScope(scope); checkProvider(provider)
  const owner = requireUser(), epoch = revision
  if (!value || (value.enabledModels !== null && (!Array.isArray(value.enabledModels) || !value.enabledModels.every(validModelId)))) throw new Error('Choose valid allowed models.')
  const profile = normalizeProfile(value), catalog = await modelCatalog(provider)
  if (currentUserId() !== owner || epoch !== revision) throw new Error('Settings changed. Reload and try again.')
  const offered = permittedModels(catalog.models, profile)
  const cleared = profile.enabledModels?.length === 0 && profile.defaultModel === null && profile.defaultReasoning === null
  if (!cleared && !offered.some(m => m.id === profile.defaultModel)) throw new Error('Choose an available, allowed default model.')
  if (profile.defaultReasoning !== null && !modelReasoning(profile.defaultModel!, catalog.models).includes(profile.defaultReasoning)) throw new Error('That reasoning level is unavailable for this model.')
  const preferences = readPreferences(), settings = aiSettings(preferences)
  settings[scope].profiles[provider] = profile
  writePreferences({ ...preferences, ai: settings }); notifyAIChanged()
}
/** A conversation's connection: its own pinned choice, or Settings' default for the feature. */
type Conversation = ChatDefaults & { provider?: AIProvider; pinnedProvider?: AIProvider }
export function conversationConfig<T extends Conversation>(scope: AIScope, chat: T): T & { provider: AIProvider } {
  const { provider, profile } = profileFor(scope, chat.pinnedProvider)
  return effectiveConversation(chat, provider, profile)
}
export function newAIConversation(scope: AIScope, pinned?: AIProvider): ChatDefaults & { provider: AIProvider } {
  const { provider, profile } = profileFor(scope, pinned)
  return { ...profileDefaults(profile), provider }
}
/**
 * Choose a connection for one conversation, leaving Settings alone. Choosing
 * the default unpins it again, so it follows Settings from then on. A model
 * belongs to a connection, so the conversation takes that connection's default
 * model and level with it.
 */
export function pinnedConversation(scope: AIScope, provider: AIProvider | null): { pinned: AIProvider | null } & ChatDefaults & { provider: AIProvider } {
  if (provider !== null) checkProvider(provider)
  const fallback = aiSettings(readPreferences())[scope].provider
  const chosen = provider ?? fallback
  return { pinned: chosen === fallback ? null : chosen, ...newAIConversation(scope, chosen) }
}
export function validateConversationModel(scope: AIScope, model: string, reasoning?: ChatDefaults['reasoning'], pinned?: AIProvider): void {
  const { provider, profile } = profileFor(scope, pinned)
  if (!validModelId(model) || (provider === 'apiKey' && !isChatModelId(model))) throw new Error(`not a chat model: ${model}`)
  if (profile.enabledModels !== null && !profile.enabledModels.includes(model)) throw new Error('Enable this model in Settings first.')
  const catalog = cachedCatalog(identity(provider))
  if ((provider === 'chatgpt' || catalog) && !catalog?.models.some(m => m.id === model)) throw new Error('This model is unavailable. Refresh models in Settings.')
  if (reasoning && !modelReasoning(model, catalog?.models ?? []).includes(reasoning)) throw new Error(`${model} does not take that reasoning level.`)
}
export function conversationReasoning(scope: AIScope, model: string, pinned?: AIProvider) {
  const { provider } = profileFor(scope, pinned)
  return modelReasoning(model, cachedCatalog(identity(provider))?.models ?? [])
}
/** Snapshot the selected connection's metadata so every round uses the same limits. */
export function conversationModelContext(provider: AIProvider, model: string): ModelContextMetadata {
  return normalizeModelContext(cachedCatalog(identity(provider))?.models.find(entry => entry.id === model) ?? {})
}

export async function getTitleGenerationSettings(provider?: AIProvider, refresh = false): Promise<TitleGenerationSettings> {
  const owner = requireUser()
  const chosen = provider ?? readPreferences().titleGeneration?.provider ?? profileFor('chat').provider
  checkProvider(chosen)
  const catalog = await modelCatalog(chosen, refresh)
  if (currentUserId() !== owner) throw new Error('The local user changed.')
  return { config: readPreferences().titleGeneration ?? null, provider: chosen, ...catalog, connection: connectionStatus(chosen) }
}

export async function setTitleGenerationSettings(config: TitleGenerationConfig | null): Promise<void> {
  const owner = requireUser(), epoch = revision
  if (config !== null) {
    if (!config || !isAIProvider(config.provider) || !validModelId(config.model) || (config.reasoning !== null && !isReasoningEffort(config.reasoning))) throw new Error('Choose valid title generation settings.')
    const catalog = await modelCatalog(config.provider)
    if (currentUserId() !== owner || epoch !== revision) throw new Error('Settings changed. Reload and try again.')
    if (!catalog.models.some(model => model.id === config.model)) throw new Error('Choose an available title model.')
    if (config.reasoning !== null && !modelReasoning(config.model, catalog.models).includes(config.reasoning)) throw new Error('That reasoning level is unavailable for this title model.')
  }
  const preferences = readPreferences()
  if (config === null) delete preferences.titleGeneration
  else preferences.titleGeneration = { provider: config.provider, model: config.model, reasoning: config.reasoning }
  writePreferences(preferences); notifyAIChanged()
}

/** Resolve title credentials separately: they can belong to a different connection from the answer. */
export async function prepareTitleRequest(fallback: TitleGenerationConfig & { key: string; reasoningEfforts: readonly NonNullable<ChatDefaults['reasoning']>[] }, signal: AbortSignal): Promise<TitleGenerationConfig & { key: string }> {
  signal.throwIfAborted()
  const owner = requireUser(), epoch = revision, config = readPreferences().titleGeneration
  if (!config) {
    const reasoning = (['low', 'minimal', 'none', 'medium', 'high', 'xhigh'] as const).find(level => fallback.reasoningEfforts.includes(level)) ?? null
    return { provider: fallback.provider, model: fallback.model, reasoning, key: fallback.key }
  }
  const connection = connectionStatus(config.provider)
  if (!connection.ready) throw new Error(connection.message)
  const catalog = await modelCatalog(config.provider)
  if (!catalog.models.some(model => model.id === config.model)) throw new Error('The title model is unavailable. Choose another in Settings.')
  if (config.reasoning !== null && !modelReasoning(config.model, catalog.models).includes(config.reasoning)) throw new Error('Choose a supported reasoning level for title generation.')
  const key = config.provider === 'apiKey' ? readKey() : await subscriptionAccessToken(subscriptionIdentity()?.id)
  signal.throwIfAborted()
  if (currentUserId() !== owner || epoch !== revision) throw new Error('The AI connection changed. Try again.')
  return { ...config, key }
}
async function resolveAIRequest<T extends Conversation>(scope: AIScope, original: T): Promise<{ chat: T & { provider: AIProvider }; key: string }> {
  const owner = requireUser(), epoch = revision, snapshot = profileFor(scope, original.pinnedProvider)
  if (!connectionStatus(snapshot.provider).ready) throw new Error(connectionStatus(snapshot.provider).message)
  // Legacy API-only users keep their existing behavior. Configured profiles and
  // subscriptions additionally check the account's current catalog.
  if (readPreferences().ai || snapshot.provider === 'chatgpt') {
    const catalog = await modelCatalog(snapshot.provider)
    if (currentUserId() !== owner || epoch !== revision) throw new Error('AI settings changed. Try sending again.')
    const offered = permittedModels(catalog.models, snapshot.profile)
    if (!offered.length) throw new Error('No models are allowed. Select a model in Settings.')
    snapshot.profile.defaultModel ??= offered[0].id
    const chat = effectiveConversation(original, snapshot.provider, snapshot.profile)
    if (!offered.some(m => m.id === snapshot.profile.defaultModel)) throw new Error('The default model is unavailable. Choose one in Settings.')
    if (!offered.some(m => m.id === chat.model)) throw new Error('This conversation’s model is unavailable. Choose another model.')
    if (chat.reasoning !== null && !modelReasoning(chat.model, catalog.models).includes(chat.reasoning)) throw new Error('Choose a supported reasoning level for this model.')
  }
  const chat = effectiveConversation(original, snapshot.provider, snapshot.profile)
  validateConversationModel(scope, chat.model, chat.reasoning, original.pinnedProvider)
  const key = snapshot.provider === 'apiKey' ? readKey() : await subscriptionAccessToken(subscriptionIdentity()?.id)
  if (currentUserId() !== owner || epoch !== revision) throw new Error('The AI connection changed. Try sending again.')
  return { chat, key }
}
export async function prepareAIRequest<T extends Conversation>(scope: AIScope, original: T, signal?: AbortSignal): Promise<{ chat: T & { provider: AIProvider }; key: string }> {
  signal?.throwIfAborted()
  const request = resolveAIRequest(scope, original)
  if (!signal) return request
  let abort!: () => void
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new Error('Message stopped before sending.'))
      signal.addEventListener('abort', abort, { once: true })
      request.then(resolve, reject)
      if (signal.aborted) abort()
    })
  } finally { signal.removeEventListener('abort', abort) }
}
/** The picker's list for Settings' connection - or, for a conversation pinned to another, for that one. */
export async function aiPickerModels(scope: AIScope, provider?: AIProvider) {
  if (provider !== undefined) checkProvider(provider)
  const settings = await getAIModelSettings(scope, provider)
  if (provider === undefined && settings.selectedProvider !== settings.provider) throw new Error('The AI connection changed. Reopen the model picker.')
  return { models: permittedModels(settings.models, settings.profile), source: settings.source, defaults: profileDefaults(settings.profile),
    error: settings.error, provider: settings.provider, defaultProvider: settings.selectedProvider, connection: settings.connection, webSearch: settings.webSearch }
}
export function smokeCatalogs(): void {
  if (!process.env['OPENCOURSE_SMOKE'] && !process.env['OPENCOURSE_SHOTS']) throw new Error('Smoke catalogs are unavailable.')
  for (const provider of ['apiKey', 'chatgpt'] as const) {
    const id = identity(provider)
    catalogs.set(id, { models: provider === 'apiKey' ? filterChatModels(['gpt-5.6-terra', 'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'gpt-4.1', 'o4-mini']) : [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gpt-5.3-codex', label: 'Codex', reasoningEfforts: ['low', 'medium', 'high'] }
    ], source: 'api' })
  }
}
