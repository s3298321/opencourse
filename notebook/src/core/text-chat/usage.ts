import type { ResponseUsage } from './agent'
export function responseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!count(v.input_tokens) || !count(v.output_tokens) || !count(v.total_tokens)) return undefined
  const input = v.input_tokens_details as Record<string, unknown> | undefined
  const output = v.output_tokens_details as Record<string, unknown> | undefined
  return { input: v.input_tokens, output: v.output_tokens, total: v.total_tokens,
    cachedInput: count(input?.cached_tokens) ? input.cached_tokens : null,
    reasoning: count(output?.reasoning_tokens) ? output.reasoning_tokens : null }
}
