import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AIModelSettings, AIProfile, AIProvider, AIScope, ReasoningEffort, SubscriptionStatus } from '@core/types'
import { modelReasoning, permittedModels } from '@core/ai'
import { REASONING_LABELS } from '@core/sidechat/models'
import ConnectionIcon, { ConnectionLabel, PROVIDER_LABELS } from './ConnectionIcon'
import Tooltip from './Tooltip'
import Menu from './Menu'

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export function SubscriptionSection(): JSX.Element {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const refresh = useCallback(() => { void window.opencourse.getSubscriptionStatus().then(setStatus).catch((error: Error) => setNote(error.message)) }, [])
  useEffect(() => { refresh(); return window.opencourse.onAIChanged(refresh) }, [refresh])
  const connect = async (id?: string): Promise<void> => {
    setBusy(true); setNote(null)
    try {
      setStatus(await window.opencourse.connectSubscription(id))
      setNote('Connected. Choose where to use your subscription below. Eligible requests use your ChatGPT plan; manage its usage in ChatGPT settings.')
    } catch (error) { setNote((error as Error).message) }
    finally { setBusy(false); refresh() }
  }
  const disconnect = async (): Promise<void> => {
    setBusy(true); setNote(null)
    try { const result = await window.opencourse.disconnectSubscription(); setNote(result.warning ?? 'Disconnected.'); refresh() }
    catch (error) { setNote((error as Error).message) }
    finally { setBusy(false) }
  }
  const active = status?.accounts.find(account => account.id === status.activeId)
  return <section className="settings-section settings-subscription">
    <h2 className="settings-connection-heading"><ConnectionIcon provider="chatgpt" />ChatGPT subscription</h2>
    <p className="meta">Use your ChatGPT plan for lesson chat, the project assistant, and course creation. Coach needs an OpenAI API key. Choose your ChatGPT workspace during browser sign-in.</p>
    <p role="status">{status === null ? 'Loading…' : active?.connected ? `Connected: ${active.label}` : 'No subscription connected.'}</p>
    {!!status?.accounts.length && <label className="settings-row"><span>Account / workspace registration</span>
      <select aria-label="ChatGPT account" value={status.activeId ?? ''} disabled={busy || status.pending} onChange={event => {
        void window.opencourse.selectSubscriptionAccount(event.target.value).then(setStatus).catch((error: Error) => setNote(error.message))
      }}>{status.accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.connected ? '' : ' (disconnected)'}</option>)}</select>
    </label>}
    <div className="actions">
      <button className="settings-subscription-connect" disabled={busy || status?.pending} onClick={() => void connect(active?.id)}>Continue with ChatGPT</button>
      {!!status?.accounts.length && <button className="secondary" disabled={busy || status.pending} onClick={() => void connect()}>Add account / workspace</button>}
      {status?.pending && <button className="secondary" onClick={() => void window.opencourse.cancelSubscriptionLogin()}>Cancel sign-in</button>}
      {active?.connected && <button className="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
      <button className="ghost" onClick={() => void window.opencourse.openExternal(CHATGPT_USAGE_URL)}>Manage usage ↗</button>
    </div>
    {status?.volatile && <p className="meta">This Mac’s keychain is unavailable. The connection lasts until you quit.</p>}
    {note && <p className="import-note" role="status">{note}</p>}
  </section>
}

export function AIModelsSection({ scope, version }: { scope: AIScope; version: number }): JSX.Element {
  const title = scope === 'chat' ? 'Chat' : scope === 'project' ? 'Project assistant' : 'Course creation'
  const purpose = scope === 'chat' ? 'lesson conversations' : scope === 'project' ? 'project questions and reviews' : 'course creation and editing'
  const [provider, setProvider] = useState<AIProvider>('apiKey')
  const [settings, setSettings] = useState<AIModelSettings | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let cancelled = false
    setSettings(previous => previous?.provider === provider && previous.scope === scope ? previous : null); setError(null)
    void window.opencourse.getAIModelSettings(scope, provider).then(result => { if (!cancelled) setSettings(result) })
      .catch((error: Error) => { if (!cancelled) setError(error.message) })
    return () => { cancelled = true }
  }, [scope, provider, version])
  const save = async (profile: AIProfile): Promise<void> => {
    setBusy(true); setError(null); setSaved(false)
    try { await window.opencourse.setAIProfile(scope, provider, profile); setSettings(await window.opencourse.getAIModelSettings(scope, provider)); setSaved(true) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const selected = async (chosen: AIProvider): Promise<void> => {
    setBusy(true); setError(null); setSaved(false)
    try { await window.opencourse.setAIProvider(scope, chosen); setSettings(await window.opencourse.getAIModelSettings(scope, provider)) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const refresh = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { setSettings(await window.opencourse.getAIModelSettings(scope, provider, true)) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const offered = settings ? permittedModels(settings.models, settings.profile) : []
  const profile = settings?.profile
  const levels = profile?.defaultModel ? modelReasoning(profile.defaultModel, settings?.models ?? []) : []
  const selectAll = (): void => {
    if (!settings || !profile) return
    const defaultModel = settings.models.some(model => model.id === profile.defaultModel) ? profile.defaultModel : settings.models[0]?.id ?? null
    void save({ ...profile, enabledModels: null, defaultModel,
      defaultReasoning: defaultModel === profile.defaultModel ? profile.defaultReasoning : null })
  }
  const toggle = (id: string, checked: boolean): void => {
    if (!settings || !profile) return
    const enabled = new Set(profile.enabledModels ?? settings.models.map(model => model.id))
    if (checked) enabled.add(id); else enabled.delete(id)
    const defaultModel = profile.defaultModel && enabled.has(profile.defaultModel) ? profile.defaultModel : settings.models.find(model => enabled.has(model.id))?.id ?? null
    void save({ ...profile, enabledModels: [...enabled], defaultModel,
      defaultReasoning: defaultModel === profile.defaultModel ? profile.defaultReasoning : null })
  }
  return <section className={`settings-section settings-ai-${scope}`}>
    <h2>{title}</h2>
    <p className="meta">Settings for {purpose}. Defaults apply to new conversations and connection switches.</p>
    <div className="settings-row"><span>Connection type</span><Tooltip label={PROVIDER_LABELS[settings?.selectedProvider ?? 'apiKey']}>
      <Menu className={`settings-ai-provider-${scope} settings-connection-picker`} align="left" disabled={busy || !settings}
        ariaLabel={`${title} connection: ${PROVIDER_LABELS[settings?.selectedProvider ?? 'apiKey']}`}
        label={<ConnectionLabel provider={settings?.selectedProvider ?? 'apiKey'} />}
        items={(['apiKey', 'chatgpt'] as const).map(value => ({ id: value, label: PROVIDER_LABELS[value], icon: <ConnectionIcon provider={value} />,
          checked: settings?.selectedProvider === value, onSelect: () => void selected(value) }))} />
    </Tooltip></div>
    <div className="settings-connection-config">
      <h3>Configure connection types</h3>
      <p className="meta">Choose which saved options to edit. The connection type used for {purpose} is selected above.</p>
      <div className="settings-row"><Tooltip label="Choose a connection type to configure">
        <Menu className={`settings-ai-configure-${scope} settings-connection-picker`} align="left" disabled={busy}
          ariaLabel={`Configure ${title.toLowerCase()} connection type: ${PROVIDER_LABELS[provider]}`}
          label={<ConnectionLabel provider={provider} />}
          items={(['apiKey', 'chatgpt'] as const).map(value => ({ id: value, label: PROVIDER_LABELS[value], icon: <ConnectionIcon provider={value} />,
            checked: provider === value, onSelect: () => { setProvider(value); setFilter(''); setSaved(false) } }))} />
      </Tooltip></div>
    {!settings ? <p className="meta">Loading models…</p> : <>
      {!settings.connection.ready && <p className="meta">{settings.connection.message}</p>}
      {settings.error && <p className="import-note error">{settings.error}</p>}
      {settings.source !== 'api' && settings.models.length > 0 && <p className="meta">{settings.source === 'cache' ? 'Showing this account’s last model catalog.' : 'Showing suggested API models until a key is connected.'}</p>}
      <div className="settings-defaults">
        <label><span>Default {scope === 'authoring' ? 'course creation' : scope} model</span><select className={`settings-default-${scope}-model`} value={profile?.defaultModel ?? ''}
          disabled={busy || !offered.length} onChange={event => {
            const model = event.target.value, reasoning = profile?.defaultReasoning
            void save({ ...profile!, defaultModel: model, defaultReasoning: reasoning && modelReasoning(model, settings.models).includes(reasoning) ? reasoning : null })
          }}>
          {!offered.some(model => model.id === profile?.defaultModel) && <option value={profile?.defaultModel ?? ''} disabled>{profile?.defaultModel ? `${profile.defaultModel} (unavailable)` : !offered.length && settings.models.length ? 'Select an allowed model' : 'Connect to choose a model'}</option>}
          {offered.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <label><span>Default reasoning</span><select className={`settings-default-${scope}-reasoning`} value={profile?.defaultReasoning ?? ''} disabled={busy || !levels.length}
          onChange={event => void save({ ...profile!, defaultReasoning: (event.target.value || null) as ReasoningEffort | null })}>
          <option value="">Model default</option>{levels.map(level => <option key={level} value={level}>{REASONING_LABELS[level]}</option>)}
        </select></label>
      </div>
      {settings.models.length > 8 && <input className="settings-key settings-filter" value={filter} placeholder="Filter models" onChange={event => setFilter(event.target.value)} />}
      <div className="actions" role="group" aria-label={`${scope} model selection`}>
        <button className="secondary settings-models-select-all" disabled={busy || !settings.models.length || profile?.enabledModels === null} onClick={selectAll}>Select all</button>
        <button className="secondary settings-models-unselect-all" disabled={busy || !offered.length} onClick={() => void save({ ...profile!, enabledModels: [], defaultModel: null, defaultReasoning: null })}>Unselect all</button>
      </div>
      <div className="settings-models" role="group" aria-label={`${scope} allowed models`}>
        {settings.models.filter(model => `${model.id} ${model.label}`.toLowerCase().includes(filter.toLowerCase())).map(model => {
          const checked = profile?.enabledModels === null || profile?.enabledModels.includes(model.id)
          return <label key={model.id} className="settings-model"><input type="checkbox" checked={checked} disabled={busy} onChange={event => toggle(model.id, event.target.checked)} />
            <span className="settings-model-id">{model.label}</span>{model.id === profile?.defaultModel && <span className="settings-model-note">new chats start here</span>}
          </label>
        })}
      </div>
      <p className="meta">{offered.length} of {settings.models.length} models allowed. {profile?.enabledModels === null ? 'New models are allowed automatically.' : 'New models stay off until you enable them.'}</p>
      <div className="actions"><button className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh models</button></div>
    </>}
    </div>
    {error && <p className="import-note error">{error}</p>}{saved && <p className="import-note" role="status">Defaults saved.</p>}
  </section>
}
