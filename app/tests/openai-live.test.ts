/**
 * The real OpenAI API. Opt-in, because `npm test` never touches the network:
 *
 *   OPENCOURSE_TEST_OPENAI=1 OPENAI_API_KEY=sk-… npx vitest run tests/openai-live.test.ts
 *
 * This is the check that catches the thing unit tests structurally cannot - a
 * renamed field, a moved endpoint, a model id that no longer exists. It costs a
 * few tenths of a cent. Run it when touching src/main/openai.ts, and at the
 * start of any work on the realtime session.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

const key = process.env['OPENAI_API_KEY'] ?? ''
const enabled = Boolean(process.env['OPENCOURSE_TEST_OPENAI']) && key !== ''

// openai.ts asks Electron for net.fetch; outside Electron, the global will do.
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) } }))

const { OpenAIError, listChatModels, listModelIds, listRealtimeModels, streamChat, validateKey } = await import(
  '../src/main/openai'
)
const { isRealtimeModelId } = await import('../src/core/coach/models')
const { DEFAULT_CHAT_MODEL, isChatModelId, reasoningEffortsFor } = await import('../src/core/sidechat/models')
const { CITE_MARK, citeAnswer } = await import('../src/core/sidechat/citations')
const { sideChatInstructions } = await import('../src/core/sidechat/prompt')

afterAll(() => vi.restoreAllMocks())

describe.skipIf(!enabled)('the OpenAI API, for real', () => {
  it('accepts a working key', async () => {
    await expect(validateKey(key)).resolves.toEqual({ ok: true })
  }, 30_000)

  it('rejects a key that looks right and is not', async () => {
    const verdict = await validateKey(`sk-proj-${'0'.repeat(40)}`)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.message).toMatch(/rejected|allowed/i)
  }, 30_000)

  it('still lists models, which is what the picker is filled from', async () => {
    const ids = await listModelIds(key)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
  }, 30_000)

  it('offers at least one speech-to-speech model this account can actually use', async () => {
    const list = await listRealtimeModels(key)
    expect(list.source).toBe('api')
    expect(list.models.length).toBeGreaterThan(0)
    expect(list.models.every((model) => isRealtimeModelId(model.id))).toBe(true)
    // If this ever fails, the curated fallback in core/coach/models.ts is stale.
    console.log('realtime models available:', list.models.map((model) => model.id).join(', '))
  }, 30_000)

  it('reports a bad request as an OpenAIError rather than throwing something raw', async () => {
    await expect(listModelIds('sk-proj-definitely-not-a-key-000000000000')).rejects.toBeInstanceOf(OpenAIError)
  }, 30_000)

  it('never lets the key into an error message', async () => {
    const leaky = `sk-proj-${'z'.repeat(40)}`
    try {
      await listModelIds(leaky)
      throw new Error('that key should not have worked')
    } catch (err) {
      expect((err as Error).message).not.toContain(leaky)
    }
  }, 30_000)
})

/**
 * Side chat's half. The reason these are worth the tenth of a cent is that the
 * unit tests replay a stream *we* wrote: nothing offline can tell us that
 * `gpt-5.6-terra` still exists, or that a text delta is still called
 * `response.output_text.delta`. If either of the first two fail, the constant
 * in core/sidechat/models.ts is stale and that is the whole fix.
 */
describe.skipIf(!enabled)('the side chat, for real', () => {
  it('offers chat models, and the default is one this account can reach', async () => {
    const list = await listChatModels(key)
    expect(list.source).toBe('api')
    expect(list.models.length).toBeGreaterThan(0)
    expect(list.models.every((model) => isChatModelId(model.id))).toBe(true)
    const ids = list.models.map((model) => model.id)
    console.log('chat models available:', ids.join(', '))
    expect(ids).toContain(DEFAULT_CHAT_MODEL)
  }, 30_000)

  it('streams an answer back in pieces, which is the only way to know the event names', async () => {
    const chunks: string[] = []
    const result = await streamChat({
      key,
      model: DEFAULT_CHAT_MODEL,
      input: [
        { role: 'system', content: 'Answer with exactly one word and no punctuation.' },
        { role: 'user', content: 'What colour is a clear midday sky? One word.' }
      ],
      onDelta: (chunk) => chunks.push(chunk)
    })
    expect(result.aborted).toBe(false)
    expect(result.text.trim().length).toBeGreaterThan(0)
    // Not merely "something came back": it came back as deltas, which is what
    // a renamed event type would silently break.
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('')).toBe(result.text)
  }, 60_000)

  // The levels a model is offered are a guess from its id (reasoningEffortsFor),
  // and this is the only thing that can check the guess. Both ends of the
  // default model's range, because the sets changed at the ends: gpt-5 had
  // `minimal`, 5.1 swapped it for `none`, 5.2 added `xhigh`. If one fails, the
  // message OpenAI sends back names the levels it would take.
  it.each(['first', 'last'] as const)("accepts the %s reasoning level the default model is offered", async (end) => {
    const levels = reasoningEffortsFor(DEFAULT_CHAT_MODEL)
    const reasoning = end === 'first' ? levels[0] : levels.at(-1)
    expect(reasoning).toBeDefined()
    const result = await streamChat({
      key,
      model: DEFAULT_CHAT_MODEL,
      reasoning,
      input: [{ role: 'user', content: 'Reply with the single word: ok' }],
      onDelta: () => undefined
    })
    expect(result.text.trim().length).toBeGreaterThan(0)
  }, 180_000)

  it('reports a bad model as an error rather than an empty answer', async () => {
    await expect(
      streamChat({
        key,
        model: 'gpt-not-a-real-model-at-all',
        input: [{ role: 'user', content: 'hi' }],
        onDelta: () => undefined
      })
    ).rejects.toBeInstanceOf(OpenAIError)
  }, 30_000)

  it('gives back what it streamed when the caller stops it', async () => {
    const controller = new AbortController()
    const result = await streamChat({
      key,
      model: DEFAULT_CHAT_MODEL,
      input: [{ role: 'user', content: 'Count slowly from one to fifty in words.' }],
      signal: controller.signal,
      onDelta: () => controller.abort()
    })
    expect(result.aborted).toBe(true)
  }, 60_000)

  // The hosted search tool's event names, and the unit of a citation's offsets,
  // are written down nowhere this app can check them. This is the canary for
  // both: the search must be reported as it runs, and every citation must be
  // placeable in the text it came with - which is what citeAnswer relies on.
  it('searches when asked to, says so, and cites pages it can place in the answer', async () => {
    const searches: string[] = []
    const result = await streamChat({
      key,
      model: DEFAULT_CHAT_MODEL,
      webSearch: true,
      input: [
        { role: 'system', content: sideChatInstructions(true) },
        {
          role: 'user',
          content:
            'Use web search: what is the latest stable release of Python listed on python.org right now? ' +
            'One sentence, and cite the page.'
        }
      ],
      onSearch: (event) => searches.push(event.state),
      onDelta: () => undefined
    })
    console.log('searched:', searches.join(', '), '\ncitations:', JSON.stringify(result.citations, null, 2))
    expect(searches).toContain('running')
    expect(searches).toContain('done')
    expect(result.citations.length).toBeGreaterThan(0)
    for (const citation of result.citations) {
      expect(citation.url).toMatch(/^https:\/\//)
      expect(citation.title.length).toBeGreaterThan(0)
    }
    const { markdown, sources } = citeAnswer(result.text, result.citations)
    expect(sources.length).toBeGreaterThan(0)
    // Every source found a place in the text: nothing fell through to the end.
    const marked = new Set([...markdown.matchAll(new RegExp(`${CITE_MARK}\\[(\\d+)\\]`, 'g'))].map((m) => Number(m[1])))
    expect(sources.every((source) => marked.has(source.n))).toBe(true)
  }, 180_000)
})
