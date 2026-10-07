import { useEffect, useState, type JSX } from 'react'
import type { AIProvider, ReasoningEffort, TitleGenerationConfig, TitleGenerationSettings } from '@core/types'
import { modelReasoning } from '@core/ai'
import { REASONING_LABELS } from '@core/sidechat/models'
import ConnectionIcon, { ConnectionLabel, PROVIDER_LABELS } from './ConnectionIcon'
import Menu from './Menu'
import Tooltip from './Tooltip'

export default function TitleGenerationSection({ version }: { version: number }): JSX.Element {
  const [settings, setSettings] = useState<TitleGenerationSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.opencourse.getTitleGenerationSettings().then(result => { if (!cancelled) setSettings(result) })
      .catch((error: Error) => { if (!cancelled) setError(error.message) })
    return () => { cancelled = true }
  }, [version])
  const update = async (action: () => Promise<TitleGenerationSettings>): Promise<void> => {
    setBusy(true); setError(null); setSaved(false)
    try { setSettings(await action()); setSaved(true) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const save = (config: TitleGenerationConfig | null): void => {
    void update(async () => {
      await window.opencourse.setTitleGenerationSettings(config)
      return window.opencourse.getTitleGenerationSettings()
    })
  }
  const selectProvider = (provider: AIProvider): void => {
    void update(async () => {
      const next = await window.opencourse.getTitleGenerationSettings(provider)
      const current = settings?.config
      const model = next.models.find(model => model.id === current?.model)?.id ?? next.models[0]?.id
      if (!model) throw new Error(next.connection.message ?? 'No title models are available for this connection. Refresh models or connect in Settings.')
      const levels = modelReasoning(model, next.models)
      const reasoning = current?.reasoning && levels.includes(current.reasoning) ? current.reasoning : levels.includes('low') ? 'low' : null
      const config = { provider, model, reasoning }
      await window.opencourse.setTitleGenerationSettings(config)
      return { ...next, config }
    })
  }
  const config = settings?.config
  const levels = config ? modelReasoning(config.model, settings?.models ?? []) : []
  const connectionLabel = config ? PROVIDER_LABELS[config.provider] : 'Use the chat’s connection and model'
  return <section className="settings-section settings-title-generation">
    <h2>Chat titles</h2>
    <p className="meta">Generate a short title after the first reply in lesson and project chats.</p>
    <div className="settings-row"><span>Connection type</span><Tooltip label={connectionLabel}>
      <Menu className="settings-title-provider settings-connection-picker" align="left" disabled={busy || !settings}
        ariaLabel={`Title generation connection: ${connectionLabel}`}
        label={config ? <ConnectionLabel provider={config.provider} /> : 'Chat settings'}
        items={[
          { id: 'conversation', label: 'Use chat settings', checked: !config, onSelect: () => save(null) },
          ...(['apiKey', 'chatgpt'] as const).map(provider => ({ id: provider, label: PROVIDER_LABELS[provider], icon: <ConnectionIcon provider={provider} />,
            checked: config?.provider === provider, onSelect: () => selectProvider(provider) }))
        ]} />
    </Tooltip></div>
    {!settings ? <p className="meta">Loading models…</p> : <>
      {!config && <p className="meta">Titles use each chat’s model and connection, with low reasoning when supported. Choose a connection above to use a dedicated model.</p>}
      {config && !settings.connection.ready && <p className="meta">{settings.connection.message}</p>}
      {config && settings.error && <p className="import-note error">{settings.error}</p>}
      <div className="settings-defaults">
        <label><span>Title model</span><select className="settings-title-model" value={config?.model ?? ''} disabled={busy || !config || !settings.models.length}
          onChange={event => {
            if (!config) return
            const model = event.target.value, supported = modelReasoning(model, settings.models)
            save({ ...config, model, reasoning: config.reasoning && supported.includes(config.reasoning) ? config.reasoning : supported.includes('low') ? 'low' : null })
          }}>
          {!config && <option value="">Chat model</option>}
          {config && !settings.models.some(model => model.id === config.model) && <option value={config.model} disabled>{config.model} (unavailable)</option>}
          {config && settings.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <label><span>Title reasoning</span><select className="settings-title-reasoning" value={config?.reasoning ?? ''} disabled={busy || !config || !levels.length}
          onChange={event => { if (config) save({ ...config, reasoning: (event.target.value || null) as ReasoningEffort | null }) }}>
          <option value="">{config ? 'Model default' : 'Low when supported'}</option>
          {config && levels.map(level => <option key={level} value={level}>{REASONING_LABELS[level]}</option>)}
        </select></label>
      </div>
      {config && <div className="actions"><button className="secondary" disabled={busy} onClick={() => {
        void update(() => window.opencourse.getTitleGenerationSettings(config.provider, true))
      }}>Refresh models</button></div>}
    </>}
    {error && <p className="import-note error" role="alert">{error}</p>}
    {saved && <p className="import-note" role="status">Title settings saved.</p>}
  </section>
}
