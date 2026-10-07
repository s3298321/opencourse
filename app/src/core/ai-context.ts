import type { ModelContextMetadata } from './types'

/**
 * Bundled defaults for catalogs that return IDs without context metadata.
 * The current Codex catalog configures these models at 272k, independently of
 * their advertised maximum: https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
 * Older API models use their documented windows: https://developers.openai.com/api/docs/models
 * Live catalog metadata always takes precedence. Do not guess for unknown IDs.
 */
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'gpt-6.1-sol': 272_000,
  'gpt-6-astra': 272_000,
  'gpt-6-sol': 272_000,
  'gpt-6-luna': 272_000,
  'gpt-5.6-sol': 272_000,
  'gpt-5.6-terra': 272_000,
  'gpt-5.1': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-4.1': 1_047_576
}

/** API thresholds must be at least 1000; discard corrupt or unusable metadata. */
export function normalizeModelContext(value: unknown): ModelContextMetadata {
  const metadata = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const valid = (tokens: unknown, minimum: number): tokens is number =>
    typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= minimum
  return {
    ...(valid(metadata.contextWindow, 1112) ? { contextWindow: metadata.contextWindow } : {}),
    ...(valid(metadata.maxContextWindow, 1112) ? { maxContextWindow: metadata.maxContextWindow } : {}),
    ...(valid(metadata.autoCompactTokenLimit, 1000) ? { autoCompactTokenLimit: metadata.autoCompactTokenLimit } : {})
  }
}

/** Match Codex ModelInfo::auto_compact_token_limit: explicit limit capped at 90%. */
export function modelCompactThreshold(model: string, metadata: ModelContextMetadata = {}): number | undefined {
  const context = normalizeModelContext(metadata)
  const window = context.contextWindow ?? context.maxContextWindow
    ?? CONTEXT_WINDOWS[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]
  const ceiling = window === undefined ? undefined : Math.floor(window * 9 / 10)
  return ceiling === undefined ? context.autoCompactTokenLimit
    : Math.min(context.autoCompactTokenLimit ?? ceiling, ceiling)
}
