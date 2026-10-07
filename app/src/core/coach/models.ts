/**
 * Which speech-to-speech models a project can use.
 *
 * OpenAI's /v1/models lists everything a key can reach with no capability
 * filter, so the real list is whatever that returns, filtered by id. This file
 * holds the filter and a curated fallback for the offline case - a first run
 * with no network should still offer a working choice rather than an empty
 * dropdown.
 */
import type { CoachModel } from '../types'

/** Known good as of the last time this was checked; the API is the source of truth. */
export const REALTIME_MODELS: readonly CoachModel[] = [
  { id: 'gpt-realtime-2.1', label: 'gpt-realtime-2.1' },
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini' },
  { id: 'gpt-realtime', label: 'gpt-realtime' }
] as const

export const DEFAULT_MODEL = 'gpt-realtime-2.1'

/** The model that fulfils the coach's web_search tool, over the Responses API. */
export const WEB_SEARCH_MODEL = 'gpt-5-mini'

export const VOICES: readonly string[] = ['marin', 'cedar', 'alloy', 'echo', 'shimmer'] as const
export const DEFAULT_VOICE = 'marin'

/**
 * A realtime model id, but not a transcription-only or preview-dated one. The
 * `-transcribe` exclusion matters: those ids match "realtime" in spirit but
 * cannot hold a speech-to-speech conversation.
 */
export function isRealtimeModelId(id: string): boolean {
  if (!id.includes('realtime')) return false
  if (id.includes('transcribe')) return false
  return true
}

/**
 * Newest-looking first, so the default sits at the top. Ids are otherwise
 * sorted lexically, which keeps the list stable between launches.
 */
export function filterRealtimeModels(ids: readonly string[]): CoachModel[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !isRealtimeModelId(id) || seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  kept.sort((a, b) => {
    if (a === DEFAULT_MODEL) return -1
    if (b === DEFAULT_MODEL) return 1
    // A plain id sorts above its own dated snapshots: gpt-realtime-2.1 before
    // gpt-realtime-2.1-2026-01-01.
    const dated = (s: string): number => (/\d{4}-\d{2}-\d{2}$/.test(s) ? 1 : 0)
    return dated(a) - dated(b) || a.localeCompare(b)
  })
  return kept.map((id) => ({ id, label: id }))
}
