import { creditUrl } from '../image-attribution'
import type { ChatCitation, ImageSearchResult } from '../types'
import { normalizeCitations } from '../sidechat/citations'

export interface ResearchSource { url: string; title: string }
export interface ResearchSnapshot { citations: ChatCitation[]; sources: ResearchSource[]; images?: ImageSearchResult[] }

/** Bound and sanitize provider data before storage or display. */
export function normalizeResearchSources(raw: unknown): ResearchSource[] {
  const seen = new Set<string>()
  return normalizeCitations(raw).flatMap(({ url, title }) => {
    if (seen.has(url)) return []
    seen.add(url)
    return [{ url, title }]
  })
}

export function researchSourcesFromOutput(output: Record<string, unknown>[]): ResearchSource[] {
  return normalizeResearchSources(output.flatMap(item => {
    if (item.type !== 'web_search_call') return []
    const action = item.action as { sources?: unknown; url?: unknown } | undefined
    return [ ...(Array.isArray(action?.sources) ? action.sources : []),
      ...(typeof action?.url === 'string' ? [{ url: action.url, title: '' }] : []) ]
  }))
}

/** Only a specific tool-capability rejection is safe to retry without search. */
export function unsupportedAuthoringSearch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; message?: unknown }
  return value.status === 400 && typeof value.message === 'string' &&
    /web_search/i.test(value.message) && /not supported|unsupported|not available|does not support/i.test(value.message)
}

/** Only explicit image results with a source page are useful for credited imports. */
export function normalizeImageResults(raw: unknown): ImageSearchResult[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.slice(0, 100).flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const image_url = creditUrl(item.image_url), source_url = creditUrl(item.source_url)
    if (!image_url || !source_url || seen.has(image_url)) return []
    seen.add(image_url)
    return [{ image_url, source_url, title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 1000) } : {}) }]
  }).slice(0, 20)
}
export function imageResultsFromOutput(output: Record<string, unknown>[]): ImageSearchResult[] {
  return normalizeImageResults(output.flatMap(item => item.type === 'web_search_call' && Array.isArray(item.results)
    ? item.results.flatMap(result => {
      if (!result || typeof result !== 'object' || (result.type !== undefined && result.type !== 'image')) return []
      return [{ ...result, source_url: result.source_url ?? result.page_url ?? result.url, description: result.description ?? result.caption }]
    }) : []))
}

/** Parameter-specific capability refusal only; generic invalid requests must still fail. */
export function unsupportedImageSearch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; message?: unknown }
  return value.status === 400 && typeof value.message === 'string' &&
    /search_content_types|image_settings|web_search_call\.results|image search/i.test(value.message) &&
    /not supported|unsupported|not available|does not support|unknown parameter|unrecognized/i.test(value.message)
}
