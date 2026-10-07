import type { AIProvider, ChatModel, ModelContextMetadata } from './types'
import type { ResponseInput } from './projects/agent'
import { isReasoningEffort } from './sidechat/models'
import { validModelId } from './ai'
import { modelCompactThreshold, normalizeModelContext } from './ai-context'

export function subscriptionModels(body: unknown): ChatModel[] {
  const models = (body as { models?: unknown })?.models
  if (!Array.isArray(models)) throw new Error('ChatGPT did not return a model catalog.')
  const seen = new Set<string>()
  return models.slice(0, 200).flatMap((entry: Record<string, unknown>) => {
    if (!entry || entry.visibility !== 'list' || !validModelId(entry.slug) || seen.has(entry.slug)) return []
    seen.add(entry.slug)
    const raw = entry.supported_reasoning_levels ?? entry.reasoning_efforts
    const levels = Array.isArray(raw) ? raw.map(level => typeof level === 'object' && level ? level.effort : level).filter(isReasoningEffort) : undefined
    return [{ id: entry.slug, label: typeof entry.display_name === 'string' ? entry.display_name.slice(0, 200) : entry.slug,
      ...normalizeModelContext({ contextWindow: entry.context_window, maxContextWindow: entry.max_context_window,
        autoCompactTokenLimit: entry.auto_compact_token_limit }),
      ...(levels ? { reasoningEfforts: [...new Set(levels)] } : {}) }]
  })
}
export function responseRequest(provider: AIProvider, options: {
  model: string; modelContext?: ModelContextMetadata; input: ResponseInput[]; tools?: readonly unknown[]; toolNamespace?: { name: string; description: string }; webSearch?: boolean; reasoning?: string
}): Record<string, unknown> {
  const subscription = provider === 'chatgpt'
  const input = subscription ? options.input.map(item => 'role' in item && item.role === 'system' ? { ...item, role: 'developer' } : item) : options.input
  const tools = subscription && options.tools?.length
    ? [{ type: 'namespace', ...(options.toolNamespace ?? { name: 'project', description: 'Read-only tools for inspecting the learner’s project files.' }), tools: options.tools }]
    : [...(options.tools ?? [])]
  if (options.webSearch) tools.push({ type: 'web_search' })
  const compactThreshold = modelCompactThreshold(options.model, options.modelContext)
  return { model: options.model, input, stream: true,
    ...(subscription || options.tools ? { store: false } : {}),
    ...(options.tools ? {
      include: ['reasoning.encrypted_content'],
      // Unknown models retain automatic compaction with an API-selected threshold.
      context_management: [{ type: 'compaction', ...(compactThreshold === undefined ? {} : { compact_threshold: compactThreshold }) }],
      ...(!subscription ? { max_output_tokens: 12000 } : {})
    } : {}),
    ...(tools.length ? { tools } : {}),
    ...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}) }
}
