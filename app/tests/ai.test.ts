// @vitest-environment node
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { aiSettings, effectiveConversation, modelReasoning, permittedModels } from '../src/core/ai'
import { normalizePreferences } from '../src/core/preferences'
import { responseRequest, subscriptionModels } from '../src/core/ai-request'
import { modelCompactThreshold, normalizeModelContext } from '../src/core/ai-context'
import { authEndpoint, validateIdToken } from '../src/core/subscription'
import { registerSecrets, scrubSecrets } from '../src/core/coach/key'

describe('independent AI profiles', () => {
  it('retains valid title settings and ignores corrupt settings without changing chat defaults', () => {
    const config = { provider: 'chatgpt', model: 'gpt-6.1-sol', reasoning: 'low' }
    expect(normalizePreferences({ titleGeneration: config }).titleGeneration).toEqual(config)
    for (const corrupt of [null, 'bad', { ...config, model: '../bad' }, { ...config, provider: 'unknown' }, { ...config, reasoning: 'bad' }]) {
      expect(normalizePreferences({ titleGeneration: corrupt }).titleGeneration).toBeUndefined()
    }
  })
  it('normalizes corrupt legacy fields before initializing missing AI profiles', () => {
    const settings = normalizePreferences({ ai: {}, chatModels: {}, defaultChatModel: 42, defaultChatReasoning: 'unsupported' }).ai!
    expect(settings.chat.profiles.apiKey).toEqual({ enabledModels: null, defaultModel: 'gpt-5.6-terra', defaultReasoning: null })
    expect(settings.project.profiles.apiKey).toEqual(settings.chat.profiles.apiKey)
  })
  it('migrates legacy defaults into both API profiles without sharing their objects', () => {
    const legacy = normalizePreferences({ chatModels: ['gpt-5.1'], defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high' })
    const settings = aiSettings(legacy)
    expect(settings.chat.provider).toBe('apiKey')
    expect(settings.project.profiles.apiKey).toEqual(settings.chat.profiles.apiKey)
    settings.project.profiles.apiKey.defaultReasoning = 'low'
    expect(settings.chat.profiles.apiKey.defaultReasoning).toBe('high')
    expect(settings.chat.profiles.chatgpt.defaultModel).toBeNull()
    expect(settings.project.profiles.chatgpt.defaultModel).toBeNull()
  })
  it('retains four independent profiles through preference normalization', () => {
    const settings = aiSettings({})
    let n = 0
    for (const scope of ['chat', 'project'] as const) for (const provider of ['apiKey', 'chatgpt'] as const) {
      settings[scope].profiles[provider] = { enabledModels: [`model-${++n}`], defaultModel: `model-${n}`, defaultReasoning: 'medium' }
    }
    settings.project.provider = 'chatgpt'
    expect(normalizePreferences(JSON.parse(JSON.stringify({ ai: settings }))).ai).toEqual(settings)
  })
  it('switches existing conversations to destination defaults and preserves valid individual choices', () => {
    const chat = { model: 'gpt-5.1', reasoning: 'high' as const, provider: 'apiKey' as const, title: 'History stays' }
    const profile = { enabledModels: ['gpt-6.1-sol'], defaultModel: 'gpt-6.1-sol', defaultReasoning: 'low' as const }
    expect(effectiveConversation(chat, 'chatgpt', profile)).toEqual({ ...chat, model: 'gpt-6.1-sol', reasoning: 'low', provider: 'chatgpt' })
    const individual = { ...chat, model: 'gpt-6.1-sol', provider: 'chatgpt' as const }
    expect(effectiveConversation(individual, 'chatgpt', profile).reasoning).toBe('high')
    expect(effectiveConversation(chat, 'apiKey', profile).model).toBe('gpt-6.1-sol')
  })
  it('does not expand a stale allowlist and uses catalog reasoning metadata', () => {
    const models = [{ id: 'gpt-6.1-sol', label: 'Sol', reasoningEfforts: ['low' as const] }]
    expect(permittedModels(models, { enabledModels: ['gone-model'], defaultModel: 'gone-model', defaultReasoning: null })).toEqual([])
    expect(modelReasoning('gpt-6.1-sol', models)).toEqual(['low'])
  })
})

describe('subscription Responses adaptation', () => {
  it('accepts visible Codex models and preserves catalog order and reasoning levels', () => {
    expect(subscriptionModels({ models: [
      { slug: 'gpt-5.3-codex', display_name: 'Codex', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] },
      { slug: 'hidden', visibility: 'hide' },
      { slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list', supported_reasoning_levels: ['low', 'high'] },
      { slug: 'gpt-5.3-codex', visibility: 'list' }
    ] })).toEqual([
      { id: 'gpt-5.3-codex', label: 'Codex', reasoningEfforts: ['medium'] },
      { id: 'gpt-6.1-sol', label: 'Sol', reasoningEfforts: ['low', 'high'] }
    ])
  })
  it('adapts instructions and project functions while retaining conversation/tool history', () => {
    const tools = [{ type: 'function', name: 'read_project_file', parameters: {} }]
    const history = [{ role: 'system', content: 'Teach' }, { role: 'user', content: 'Review' },
      { type: 'function_call_output', call_id: 'one', output: 'file text' }]
    const body = responseRequest('chatgpt', { model: 'gpt-6.1-sol', input: history, tools, webSearch: true, reasoning: 'high' })
    expect(body).toMatchObject({ store: false, stream: true, input: [{ role: 'developer', content: 'Teach' }, ...history.slice(1)],
      tools: [{ type: 'namespace', name: 'project', tools }, { type: 'web_search' }], reasoning: { effort: 'high' } })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('previous_response_id')
    expect(responseRequest('apiKey', { model: 'gpt-5.1', input: history, tools })).toMatchObject({ tools, max_output_tokens: 12000, input: history })
  })
  it.each(['apiKey', 'chatgpt'] as const)('enables inline compaction for tool loops with %s', provider => {
    const body = responseRequest(provider, { model: 'gpt-6.1-sol', input: [], tools: [{ type: 'function', name: 'read_course' }] })
    expect(body).toMatchObject({ store: false, stream: true,
      context_management: [{ type: 'compaction', compact_threshold: 244_800 }] })
    expect(responseRequest(provider, { model: 'gpt-6.1-sol', input: [] })).not.toHaveProperty('context_management')
  })
  it('retains validated context limits from subscription model metadata', () => {
    expect(subscriptionModels({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', context_window: 272_000,
      max_context_window: 872_000, auto_compact_token_limit: 200_000 }] })).toEqual([
      { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', contextWindow: 272_000, maxContextWindow: 872_000, autoCompactTokenLimit: 200_000 }
    ])
    expect(subscriptionModels({ models: [{ slug: 'gpt-new', visibility: 'list', context_window: '272000',
      max_context_window: -1, auto_compact_token_limit: 999 }] })).toEqual([{ id: 'gpt-new', label: 'gpt-new' }])
  })
})

describe('Codex compaction thresholds', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra'])('uses the configured Codex window for %s', model => {
    expect(modelCompactThreshold(model)).toBe(244_800)
  })
  it('prefers the catalog window over the maximum and bundled metadata, with lower overrides', () => {
    expect(modelCompactThreshold('gpt-6.1-sol', { contextWindow: 100_001, maxContextWindow: 872_000 })).toBe(90_000)
    expect(modelCompactThreshold('gpt-6.1-sol', { contextWindow: 100_001, autoCompactTokenLimit: 50_000 })).toBe(50_000)
    expect(modelCompactThreshold('gpt-6.1-sol', { contextWindow: 100_001, autoCompactTokenLimit: 200_000 })).toBe(90_000)
    expect(modelCompactThreshold('gpt-new', { maxContextWindow: 200_000 })).toBe(180_000)
    expect(modelCompactThreshold('gpt-new', { autoCompactTokenLimit: 100_000 })).toBe(100_000)
  })
  it('uses documented older model windows and handles dated model IDs', () => {
    expect(modelCompactThreshold('gpt-5.1')).toBe(360_000)
    expect(modelCompactThreshold('gpt-5-mini')).toBe(360_000)
    expect(modelCompactThreshold('gpt-4.1-2025-04-14')).toBe(942_818)
    expect(modelCompactThreshold('gpt-6.1-sol-2026-10-01')).toBe(244_800)
  })
  it('ignores invalid limits and lets the API choose for models with no known window', () => {
    for (const corrupt of [null, NaN, Infinity, -10, 999, 2000.5, '272000', Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeModelContext({ contextWindow: corrupt, maxContextWindow: corrupt, autoCompactTokenLimit: corrupt })).toEqual({})
    }
    expect(modelCompactThreshold('gpt-unknown')).toBeUndefined()
    expect(responseRequest('apiKey', { model: 'gpt-unknown', input: [], tools: [] }).context_management).toEqual([{ type: 'compaction' }])
  })
})

describe('OpenAI identity validation and redaction', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'one', alg: 'RS256', use: 'sig' }] }
  const jwt = (changes: Record<string, unknown> = {}, key = privateKey): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'one' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_one', sub: 'account-one',
      exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'nonce-one', email: 'learner@example.com', ...changes })).toString('base64url')
    const input = `${header}.${payload}`
    return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`
  }
  it('verifies a signed identity and rejects invalid issuer, audience, expiry, nonce and signature', () => {
    expect(validateIdToken(jwt(), jwks, 'oaiapp_one', 'nonce-one')).toEqual({ subject: 'account-one', email: 'learner@example.com' })
    for (const changes of [{ iss: 'https://attacker.example' }, { aud: 'wrong' }, { exp: 1 }, { nonce: 'wrong' }]) {
      expect(() => validateIdToken(jwt(changes), jwks, 'oaiapp_one', 'nonce-one')).toThrow('validation failed')
    }
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => validateIdToken(jwt({}, other.privateKey), jwks, 'oaiapp_one', 'nonce-one')).toThrow('validation failed')
    expect(() => authEndpoint('https://attacker.example/keys')).toThrow('endpoint')
  })
  it('redacts identity JWTs, opaque tokens, and authorization URL hints', () => {
    const token = jwt()
    registerSecrets('opaque-refresh-token-value')
    const clean = scrubSecrets(`Rejected ${token} opaque-refresh-token-value https://auth.openai.com/a?id_token_hint=${encodeURIComponent(token)}&code=private-code`)
    expect(clean).not.toContain(token)
    expect(clean).not.toContain('opaque-refresh-token-value')
    expect(clean).not.toContain('private-code')
  })
})
