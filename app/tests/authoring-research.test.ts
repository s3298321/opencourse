// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizePreferences } from '../src/core/preferences'
import { responseRequest } from '../src/core/ai-request'
import { authoringInstructions } from '../src/core/authoring/prompt'
import { normalizeResearchSources, researchSourcesFromOutput, unsupportedAuthoringSearch } from '../src/core/authoring/research'
import { compactInput } from '../src/core/text-chat/agent'

describe('authoring research contract', () => {
  it.each(['apiKey', 'chatgpt'] as const)('combines search and edit tools for %s without forcing search', provider => {
    const body = responseRequest(provider, { model: 'gpt-5.6-terra', input: [{ role: 'system', content: authoringInstructions(true) }], tools: [{ type: 'function', name: 'read_course' }], toolNamespace: { name: 'authoring', description: 'Edit' }, webSearch: true })
    expect(body.tools).toContainEqual({ type: 'web_search' })
    expect(body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources'])
    expect(body.tool_choice).toBeUndefined()
    expect((body.input as { role: string }[])[0].role).toBe(provider === 'chatgpt' ? 'developer' : 'system')
  })
  it('preserves explicit authoring opt-out without enabling side chat', () => {
    expect(normalizePreferences({ authoringWebSearch: false })).toEqual({ authoringWebSearch: false })
    expect(normalizePreferences({ authoringWebSearch: 'false' })).toEqual({})
    expect(normalizePreferences({ authoringWebSearch: true, webSearch: false })).toEqual({ authoringWebSearch: true })
  })
  it('sanitizes, bounds and deduplicates untrusted source data', () => {
    expect(normalizeResearchSources([{ url: 'javascript:alert(1)' }, { url: 'https://docs.python.org/', title: 'Python' }, { url: 'https://docs.python.org/' }, null])).toEqual([{ url: 'https://docs.python.org/', title: 'Python' }])
    expect(normalizeResearchSources(Array.from({ length: 100 }, (_, i) => ({ url: `https://example.org/${i}` })))).toHaveLength(50)
    expect(researchSourcesFromOutput([{ type: 'web_search_call', action: { type: 'open_page', url: 'https://docs.python.org/' } }])).toEqual([{ url: 'https://docs.python.org/', title: '' }])
  })
  it('does not disguise unrelated bad requests or transient failures as missing capability', () => {
    for (const error of [{ status: 400, message: 'Invalid tool schema' }, { status: 400, message: 'Invalid web_search parameter' }, { status: 503, message: 'web_search is not supported' }]) expect(unsupportedAuthoringSearch(error)).toBe(false)
  })
  it('retains teaching and research instructions across compaction', () => {
    const instructions = [{ role: 'system', content: authoringInstructions(true) }]
    expect(compactInput([...instructions, { role: 'user', content: 'Old' }, { type: 'compaction', encrypted_content: 'state' }], instructions)[0]).toEqual(instructions[0])
  })
})

import { imageResultsFromOutput, normalizeImageResults, unsupportedImageSearch } from '../src/core/authoring/research'
import { validateManifest } from '../src/core/schema'
import { projectCourse } from './helpers/project'
import { creditUrl, parseImageAttribution } from '../src/core/image-attribution'

describe('image search and portable credits', () => {
  it.each(['apiKey', 'chatgpt'] as const)('opts authoring into images for %s without changing ordinary search', provider => {
    const options = { model: 'test', input: [], tools: [], webSearch: true, imageSearch: true }
    const request = responseRequest(provider, options)
    expect(request.tools).toContainEqual({ type: 'web_search', search_content_types: ['image', 'text'], image_settings: { max_results: 5, caption: true } })
    expect(request.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results'])
    expect(responseRequest(provider, { ...options, webSearch: false }).tools).toBeUndefined()
    expect(responseRequest(provider, { ...options, imageSearch: false }).tools).toContainEqual({ type: 'web_search' })
  })
  it('bounds image metadata and rejects missing sources, unsafe links and duplicate results', () => {
    const result = { type: 'image', image_url: 'https://images.example.org/a.png', source_url: 'https://example.org/photo', title: 'Photo', caption: 'A useful example' }
    expect(imageResultsFromOutput([{ type: 'web_search_call', results: [result, result, null, { ...result, image_url: 'javascript:evil()' }, { ...result, source_url: undefined }] }])).toEqual([{ image_url: result.image_url, source_url: result.source_url, title: result.title, description: result.caption }])
    expect(normalizeImageResults(Array.from({ length: 50 }, (_, n) => ({ ...result, image_url: `https://example.org/${n}`, title: 'a'.repeat(1000) })))).toHaveLength(20)
    expect(creditUrl('https://user:password@example.org/image')).toBeUndefined()
    expect(parseImageAttribution({ source_url: 'https://example.org/photo', author: undefined })).toMatchObject({ source_url: 'https://example.org/photo' })
  })
  it('only falls back for explicit image capability rejections', () => {
    for (const message of ['image_settings is not supported', 'Unknown parameter: search_content_types', 'web_search_call.results is not available']) expect(unsupportedImageSearch({ status: 400, message })).toBe(true)
    for (const error of [{ status: 400, message: 'Invalid image_settings value' }, { status: 503, message: 'image search is not supported' }, { status: 400, message: 'Invalid tool schema' }]) expect(unsupportedImageSearch(error)).toBe(false)
  })
  it('requires 1.8 for credits while retaining old image blocks and rejects executable URLs', () => {
    const course = { ...projectCourse(), schema_version: '1.8', version: '0.1.0' }
    const block = { type: 'image' as const, slug: 'photo', src: 'assets/photo.png', attribution: { source_url: 'https://example.org/photo', author: '<script>Plain text</script>', license: 'CC BY 4.0' } }
    course.modules[0].lessons![0].blocks.push(block)
    expect(validateManifest(course)).toEqual([])
    expect(validateManifest({ ...course, schema_version: '1.7' }).join(' ')).toContain('1.8')
    block.attribution.source_url = 'javascript:alert(1)'
    expect(validateManifest(course).length).toBeGreaterThan(0)
    block.attribution.source_url = 'https://user:pass@example.org/a'
    expect(validateManifest(course).join(' ')).toContain('without credentials')
    delete (block as { attribution?: unknown }).attribution
    for (const schema_version of ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7']) {
      const legacy = { ...course, schema_version, modules: [{ slug: 'm', title: 'M', lessons: [{ slug: 'l', title: 'L', blocks: [block] }] }] }
      expect(validateManifest(legacy)).toEqual([])
    }
  })
})
