import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { ServerAIDefaults, ServerAISettings } from '@core/learning/types'
import { isReasoningEffort, reasoningEffortsFor } from '@core/sidechat/models'
import type { Ctx } from '../context'
import { conflict } from '../errors'

export function keyring(ctx: Pick<Ctx, 'db' | 'config'>): { id: string; keys: Record<string, Buffer> } {
  const raw = ctx.config.aiEncryptionKeys
  if (!raw) throw conflict('ai_disabled', 'The server operator must configure AI credential encryption first.')
  let input: Record<string, string>
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('Invalid AI encryption configuration.')
  }
  const keys: Record<string, Buffer> = Object.create(null)
  for (const [id, key] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key))
      throw new Error('Invalid AI encryption configuration.')
    keys[id] = Buffer.from(key, 'hex')
  }
  const id = ctx.config.aiActiveKey ?? Object.keys(keys)[0]
  if (!keys[id]) throw new Error('The active AI encryption key is missing.')
  return { id, keys }
}
export function sealKey(ctx: Pick<Ctx, 'db' | 'config'>, account: string, value: string): string {
  const ring = keyring(ctx),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', ring.keys[ring.id], iv)
  cipher.setAAD(Buffer.from(account))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return JSON.stringify({
    key: ring.id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  })
}
export function readAIKey(ctx: Pick<Ctx, 'db' | 'config'>, account: string): string {
  const row = ctx.db.prepare('SELECT secret FROM learning_ai WHERE account_id=?').get(account) as
    { secret: string | null } | undefined
  if (!row?.secret) throw conflict('ai_not_configured', 'Configure an OpenAI API key for this server in Settings.')
  const ring = keyring(ctx),
    v = JSON.parse(row.secret),
    key = ring.keys[v.key]
  if (!key)
    throw conflict('ai_key_unavailable', 'The stored credential cannot be decrypted. Contact the server operator.')
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'))
  cipher.setAAD(Buffer.from(account))
  cipher.setAuthTag(Buffer.from(v.tag, 'base64'))
  const value = Buffer.concat([cipher.update(Buffer.from(v.data, 'base64')), cipher.final()]).toString('utf8')
  if (v.key !== ring.id)
    ctx.db.prepare('UPDATE learning_ai SET secret=? WHERE account_id=?').run(sealKey(ctx, account, value), account)
  return value
}
export const DEFAULT_SERVER_MODEL = 'gpt-4.1-mini'
/**
 * A level the model does not take is dropped in the same write that chose the
 * model, as the app's side chat does: a level OpenAI refuses breaks every
 * question in the chat, and no level is the model's own default.
 */
export function fittedReasoning(model: string, reasoning: unknown): ServerAIDefaults['reasoning'] {
  return isReasoningEffort(reasoning) && reasoningEffortsFor(model).includes(reasoning) ? reasoning : null
}
/** What naming a chat sends: the configured title model, or the chat's own at low reasoning when it takes one. */
export function titleDefaults(settings: Pick<ServerAISettings, 'model' | 'title'>): ServerAIDefaults {
  return settings.title ?? { model: settings.model, reasoning: fittedReasoning(settings.model, 'low') }
}
export function aiSettings(ctx: Pick<Ctx, 'db' | 'config'>, account: string): ServerAISettings {
  const row = ctx.db
    .prepare(
      'SELECT hint,model,reasoning,enabled_models,web_search,title_model,title_reasoning,secret IS NOT NULL AS configured FROM learning_ai WHERE account_id=?'
    )
    .get(account) as
    | {
        hint: string | null
        model: string
        reasoning: string | null
        web_search: number
        title_model: string | null
        title_reasoning: string | null
        enabled_models: string | null
        configured: number
      }
    | undefined
  const model = row?.model ?? DEFAULT_SERVER_MODEL
  return {
    enabledModels: row?.enabled_models ? JSON.parse(row.enabled_models) : null,
    configured: Boolean(row?.configured),
    hint: row?.hint ?? null,
    model,
    reasoning: fittedReasoning(model, row?.reasoning),
    webSearch: Boolean(row?.web_search),
    title: row?.title_model
      ? { model: row.title_model, reasoning: fittedReasoning(row.title_model, row.title_reasoning) }
      : null,
    enabled: Boolean(ctx.config.aiEncryptionKeys)
  }
}
