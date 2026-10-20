import { useEffect, useState } from 'react'
import type { ServerAIDefaults, ServerAIModels, ServerAISettings } from '../core/learning/types'
import type { ChatModel, ReasoningEffort } from '../core/types'
import { REASONING_LABELS, reasoningEffortsFor, webSearchFor } from '../core/sidechat/models'
import type { LearningClient } from './client'
import './learning.css'

/** A level the new model cannot take is dropped with the change, as the server would. */
const fitted = (model: string, reasoning: ReasoningEffort | null): ReasoningEffort | null =>
  reasoning && reasoningEffortsFor(model).includes(reasoning) ? reasoning : null

const settingsValue = (settings: ServerAISettings) => JSON.stringify({
  model: settings.model,
  reasoning: settings.reasoning,
  webSearch: settings.webSearch,
  title: settings.title && { model: settings.title.model, reasoning: settings.title.reasoning },
  enabledModels: settings.enabledModels == null ? null : [...settings.enabledModels].sort()
})

/** One activity's model and reasoning. The model a setting already names stays offered when the list lacks it. */
function DefaultsPicker({
  label,
  models,
  value,
  inherit,
  disabled,
  onChange
}: {
  label: string
  models: ChatModel[]
  value: ServerAIDefaults | null
  /** Offered as the first choice, meaning "no model of its own". */
  inherit?: { label: string; reasoning: string }
  disabled: boolean
  onChange: (value: ServerAIDefaults | null) => void
}) {
  const levels = value ? reasoningEffortsFor(value.model) : []
  return (
    <div className="learning-settings-pair">
      <label>
        {label} model
        <select
          value={value?.model ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const model = e.target.value
            if (!model) return onChange(null)
            // A fresh choice starts at low when the model takes it, as the app's title settings do.
            const reasoning = value ? fitted(model, value.reasoning) : inherit ? fitted(model, 'low') : null
            onChange({ model, reasoning })
          }}
        >
          {inherit && <option value="">{inherit.label}</option>}
          {value && !models.some((m) => m.id === value.model) && <option value={value.model}>{value.model}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {label} reasoning
        <select
          value={value?.reasoning ?? ''}
          disabled={disabled || !levels.length}
          onChange={(e) => value && onChange({ ...value, reasoning: (e.target.value || null) as ReasoningEffort | null })}
        >
          <option value="">{!value && inherit ? inherit.reasoning : levels.length ? 'Model default' : 'Not adjustable'}</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {REASONING_LABELS[level]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
export function ConnectionSettings({
  client,
  username,
  onUsername
}: {
  client: LearningClient
  username: string
  onUsername?: () => void
}) {
  const [settings, setSettings] = useState<ServerAISettings | null>(null),
    [savedSettings, setSavedSettings] = useState<ServerAISettings | null>(null),
    [key, setKey] = useState(''),
    [name, setName] = useState(username),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState(''),
    [models, setModels] = useState<ServerAIModels | null>(null)
  const changed = Boolean(key || (settings && savedSettings && settingsValue(settings) !== settingsValue(savedSettings)))
  function acceptSettings(value: ServerAISettings) {
    setSettings(value)
    setSavedSettings(value)
  }
  const ready = settings?.configured === true && settings.enabled
  const listFor = ready ? settings.hint : null
  useEffect(() => {
    let cancelled = false
    setModels(null)
    if (!ready) return
    void client
      .request<ServerAIModels>('/me/ai/models')
      .then((result) => { if (!cancelled) setModels(result) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [client, ready, listFor])
  useEffect(() => {
    void client
      .request<ServerAISettings>('/me/ai')
      .then(acceptSettings)
      .catch((e) => setError(e.message))
  }, [client])
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="learning-settings">
      <h2>Server account and AI</h2>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await client.request('/me/username', 'PUT', { username: name })
            onUsername?.()
          })
        }}
      >
        <label>
          Username on this server
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        </label>
        <button disabled={busy}>Save username</button>
      </form>
      {settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || !settings.enabled || !changed) return
            const secret = key
            void run(async () => {
              acceptSettings(
                await client.request('/me/ai', 'PUT', {
                  ...(secret ? { key: secret } : {}),
                  enabledModels: settings.enabledModels ?? null,
                  model: settings.model,
                  reasoning: settings.reasoning,
                  webSearch: settings.webSearch,
                  title: settings.title
                })
              )
              setKey('')
            })
          }}
        >
          <p>
            {settings.configured
              ? `API key configured · ending ${settings.hint}`
              : 'Configure your API key to enable chat on this server.'}
          </p>
          {!settings.enabled && <p>The server operator has not enabled encrypted credential storage.</p>}
          <label>
            OpenAI API key
            <input
              type="password"
              disabled={busy}
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={settings.configured ? 'Replace key' : 'sk-…'}
            />
          </label>
          {ready && <>
            <fieldset>
              <legend>Study chat</legend>
              <p className="meta">Questions about a course or document you are reading.</p>
              <DefaultsPicker
                label="Chat"
                models={(models?.models ?? []).filter(m => settings.enabledModels == null || settings.enabledModels.includes(m.id))}
                value={settings}
                disabled={busy}
                onChange={(value) => value && setSettings({ ...settings, ...value })}
              />
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={settings.webSearch}
                  onChange={(e) => setSettings({ ...settings, webSearch: e.target.checked })}
                />
                Allow web search
              </label>
              {settings.webSearch && !webSearchFor(settings.model, settings.reasoning) && (
                <p className="meta">This model cannot search the web at this reasoning level, so it answers without searching.</p>
              )}
            </fieldset>
            <fieldset>
              <legend>Models available in chat</legend>
              <p className="meta">Choose which models appear in the composer. The chat model above is the default for new conversations.</p>
              <input aria-label="Filter models" placeholder="Filter models" value={filter} onChange={e => setFilter(e.target.value)} />
              <div className="learning-model-actions">
                <button type="button" disabled={busy} onClick={() => setSettings({ ...settings, enabledModels: null })}>Select all</button>
                <button type="button" disabled={busy} onClick={() => setSettings({ ...settings, enabledModels: [] })}>Unselect all</button>
              </div>
              <div className="learning-model-list" role="group" aria-label="Allowed chat models">
                {(models?.models ?? []).filter(m => `${m.id} ${m.label}`.toLowerCase().includes(filter.toLowerCase())).map(m => <label className="learning-model-option" key={m.id}>
                  <input type="checkbox" disabled={busy} checked={settings.enabledModels == null || settings.enabledModels.includes(m.id)} onChange={e => {
                    const enabled = new Set(settings.enabledModels ?? models?.models.map(m => m.id) ?? [])
                    if (e.target.checked) enabled.add(m.id); else enabled.delete(m.id)
                    const model = enabled.has(settings.model) ? settings.model : [...enabled][0] ?? settings.model
                    setSettings({ ...settings, enabledModels: [...enabled], model, reasoning: fitted(model, settings.reasoning) })
                  }} />{m.label}
                </label>)}
              </div>
              <p className="meta">{settings.enabledModels == null ? 'New models are allowed automatically.' : settings.enabledModels.length ? 'New models stay off until you enable them.' : 'Enable a model to use chat.'}</p>
            </fieldset>
            <fieldset>
              <legend>Chat titles</legend>
              <p className="meta">Names each conversation’s tab after its first answer.</p>
              <DefaultsPicker
                label="Title"
                models={models?.models ?? []}
                value={settings.title}
                inherit={{ label: 'Same as study chat', reasoning: 'Low when supported' }}
                disabled={busy}
                onChange={(title) => setSettings({ ...settings, title })}
              />
            </fieldset>
            {models?.error && <p className="meta">{models.error} Showing a default list of models.</p>}
          </>}
          <div className="learning-settings-actions">
            <button className="learning-settings-save" disabled={busy || !settings.enabled || !changed}>Save AI settings</button>
            {settings.configured && <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(async () => acceptSettings(await client.request('/me/ai', 'DELETE')))}
            >
              Remove API key
            </button>}
          </div>
        </form>
      )}
    </section>
  )
}
