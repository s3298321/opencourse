import { useEffect, useLayoutEffect, useState, useRef, type ReactNode } from 'react'
import type { ContentRef, ServerAISettings, ServerAIModels } from '../core/learning/types'
import type { LearningClient } from './client'
import './learning.css'
import { REASONING_LABELS, reasoningEffortsFor } from '../core/sidechat/models'
import Menu from './Menu'
import ConnectionIcon from './ConnectionIcon'
import { ReadingMessage, Thinking, type ReadingCitation } from './ReadingMessage'
import { ChatIcon } from './ChatIcon'
import { useReadingTabs } from './useReadingTabs'
import ChatTabTitle from './ChatTabTitle'

function ReadingChatPanel({
  client,
  source,
  quote,
  onQuoteUsed,
  draftKey,
  visible = true,
  onClose,
  settingsLink,
  renderAnswer,
  onSource
}: {
  onSource?: (source: ReadingCitation) => void
  visible?: boolean
  onClose?: () => void
  settingsLink?: ReactNode
  renderAnswer?: (text: string) => ReactNode
  draftKey?: string
  client: LearningClient
  source: ContentRef
  quote?: string
  onQuoteUsed?: () => void
}) {
  const storageKey = `opencourse:reading-draft:${draftKey ?? `${source.kind}:${source.id}`}`
  const panel = useReadingTabs(client, source, storageKey)
  const { chats, view, text, setText, error, setError, busy, answering } = panel
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settings, setSettings] = useState<ServerAISettings | null>(null)
  const [catalog, setCatalog] = useState<ServerAIModels | null>(null)
  const configured = settings ? settings.configured && settings.enabled : null
  const modelChoices = (catalog?.models ?? []).filter(m => settings?.enabledModels == null || settings.enabledModels.includes(m.id))
  const lastAnswer = view?.messages.slice().reverse().find(m => m.model)
  const saved = panel.selection ?? (lastAnswer?.model ? { model: lastAnswer.model, reasoning: lastAnswer.reasoning ?? null } : null)
  const chosen = saved && (settings?.enabledModels == null || settings.enabledModels.includes(saved.model)) ? saved : settings
  const model = chosen?.model ?? ''
  const reasoning = chosen?.reasoning ?? null
  const efforts = reasoningEffortsFor(model)
  const modelEnabled = !!model && (settings?.enabledModels == null || settings.enabledModels.includes(model))
  useEffect(() => {
    let alive = true
    if (configured) void client.request<ServerAIModels>('/me/ai/models').then(result => { if (alive) setCatalog(result) }).catch(() => {})
    else setCatalog(null)
    return () => { alive = false }
  }, [client, configured, settings?.hint])
  const field = useRef<HTMLTextAreaElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = tabList.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected=true]')?.parentElement
    if (!list || !selected) return
    const reveal = () => {
      const item = selected.getBoundingClientRect(),
        bounds = list.getBoundingClientRect()
      if (item.right > bounds.right) list.scrollLeft += item.right - bounds.right
      else if (item.left < bounds.left) list.scrollLeft += item.left - bounds.left
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(selected)
    observer.observe(list)
    return () => observer.disconnect()
  }, [panel.active, panel.tabs])
  const following = useRef(true)
  useEffect(() => {
    if (visible && !panel.loading) field.current?.focus({ preventScroll: true })
  }, [visible, panel.loading])
  useEffect(() => {
    const input = field.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`
  }, [text, visible])
  useEffect(() => {
    if (visible && following.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight
  }, [view, visible])
  useEffect(() => {
    let alive = true
    const refresh = () =>
      void client
        .request<ServerAISettings>('/me/ai')
        .then((s) => {
          if (alive) setSettings(s)
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 30000)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [client])
  async function send() {
    if (configured !== true || !modelEnabled) return
    following.current = true
    if (await panel.send(quote, text, { model, reasoning })) onQuoteUsed?.()
  }
  function select(id: string) {
    following.current = true
    panel.open(id)
    setHistoryOpen(false)
    field.current?.focus({ preventScroll: true })
  }
  return (
    <aside className="learning-chat" aria-label="Reading chat">
      <header className="learning-chat-header">
        <ChatIcon />
        <h2>Ask about this {source.kind === 'course' ? 'lesson' : 'document'}</h2>
        {onClose && (
          <button
            type="button"
            className="learning-chat-icon"
            aria-label="Close chat"
            title="Close chat"
            onClick={onClose}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        )}
      </header>
      <div className="learning-chat-tabs">
        <div className="learning-chat-tab-list" role="tablist" aria-label="Conversations" ref={tabList}>
          {panel.tabs.map((id) => {
            const chat = chats.find((c) => c.id === id)
            const title = chat?.title || 'New chat'
            const label = title.length > 26 ? `${title.slice(0, 26)}…` : title
            return (
              <span className={`learning-chat-tab${id === panel.active ? ' active' : ''}`} key={id}>
                <button
                  type="button"
                  role="tab"
                  tabIndex={id === panel.active ? 0 : -1}
                  onKeyDown={(event) => {
                    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                    if (!offset && event.key !== 'Home' && event.key !== 'End') return
                    event.preventDefault()
                    const index =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? panel.tabs.length - 1
                          : (panel.tabs.indexOf(id) + offset + panel.tabs.length) % panel.tabs.length
                    panel.open(panel.tabs[index])
                    tabList.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[index]?.focus()
                  }}
                  aria-selected={id === panel.active}
                  title={title}
                  onClick={() => select(id)}
                >
                  {chat?.running && <span className="learning-chat-dot" aria-label="Answering" />}
                  <ChatTabTitle title={label} />
                </button>
                <button
                  type="button"
                  className="learning-chat-tab-close"
                  aria-label={`Close tab: ${title}`}
                  title="Close this tab (the chat is kept)"
                  disabled={panel.sending}
                  onClick={() => panel.close(id)}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
        <button
          type="button"
          className="learning-chat-new"
          aria-label="New chat"
          title="Start another chat"
          disabled={!panel.ready}
          onClick={() => {
            panel.startNew()
            setHistoryOpen(false)
            field.current?.focus({ preventScroll: true })
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className={`learning-chat-history-toggle${historyOpen ? ' active' : ''}`}
          aria-expanded={historyOpen}
          aria-controls="reading-chat-history"
          onClick={() => {
            if (!historyOpen) void panel.refreshHistory()
            setHistoryOpen((open) => !open)
          }}
        >
          History
        </button>
      </div>
      <div className="learning-chat-transcript">
        {historyOpen && (
          <div className="learning-chat-history" id="reading-chat-history" aria-label="Conversation history">
            {chats.length === 0 && <p className="learning-chat-history-empty">No conversations yet.</p>}
            {chats.map((chat) => (
              <div className="learning-chat-history-row" key={chat.id}>
                <button type="button" className="learning-chat-history-open" onClick={() => select(chat.id)}>
                  <span>{chat.title || 'A new chat'}</span>
                  <small>
                    Conversation
                    {chat.messages !== undefined ? ` · ${chat.messages} message${chat.messages === 1 ? '' : 's'}` : ''}
                    {' · '}
                    {new Date(chat.lastMessageAt ?? chat.createdAt).toLocaleString()}
                  </small>
                </button>
                <button
                  type="button"
                  className="learning-chat-tab-close"
                  aria-label={`Delete chat: ${chat.title || 'A new chat'}`}
                  title="Delete this chat for good"
                  disabled={panel.sending}
                  onClick={() => {
                    if (window.confirm('Delete this chat? This cannot be undone.')) void panel.remove(chat.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {configured === false && (
          <div className="learning-chat-notice">
            <p>Configure an API key in this server’s settings to enable chat. Reading remains available.</p>
            {settingsLink}
          </div>
        )}
        {error && (
          <p className="learning-chat-error" role="alert">
            {error}
          </p>
        )}
        <div
          className="learning-messages"
          ref={transcript}
          aria-live="polite"
          onScroll={() => {
            const el = transcript.current
            if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {!view?.messages.length && (
            <div className="learning-chat-empty">
              <p>Ask about this {source.kind === 'course' ? 'lesson' : 'document'}.</p>
            </div>
          )}
          {view?.messages.map((m) => <ReadingMessage key={m.id} message={m} renderAnswer={renderAnswer} onSource={onSource} />)}
          {busy && !answering && <Thinking />}

        </div>
      </div>
      <form
        className="learning-chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="learning-chat-box">
          {quote && (
            <div className="sidechat-quote">
              <div className="sidechat-quote-head">
                <span className="sidechat-quote-label">{source.kind === 'course' ? 'From the lesson' : 'From the document'}</span>
                <button
                  type="button"
                  className="learning-chat-icon"
                  aria-label="Remove selected passage"
                  onClick={onQuoteUsed}
                >
                  ×
                </button>
              </div>
              <blockquote>{quote}</blockquote>
            </div>
          )}
          <textarea
            ref={field}
            aria-label="Your question"
            rows={1}
            placeholder={
              quote
                ? 'Ask about the selected passage…'
                : `Ask about this ${source.kind === 'course' ? 'lesson' : 'document'}…`
            }
            value={text}
            maxLength={12000}
            onChange={(e) => {
              setText(e.target.value)
            }}
            disabled={busy || answering || panel.loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="learning-chat-actions">
            <span className="learning-chat-connection" role="img" aria-label="OpenAI API key" title="OpenAI API key · managed in Settings"><ConnectionIcon provider="apiKey" /></span>
            {configured && modelEnabled && <>
              <Menu className="learning-chat-picker learning-chat-model" panelClassName="learning-chat-menu" screenActive={visible} resetKey={panel.active}
                label={<span className="learning-chat-picker-label">{model}</span>} ariaLabel="Model for this chat" title="Which model answers" align="left" side="above" disabled={busy || answering}
                items={[...(!modelChoices.some(m => m.id === model) ? [{ id: model, label: model }] : []), ...modelChoices].map(m => ({
                  id: m.id, label: m.label, checked: m.id === model,
                  onSelect: () => panel.setSelection({ model: m.id, reasoning: reasoning && reasoningEffortsFor(m.id).includes(reasoning) ? reasoning : null })
                }))} />
              {!!efforts.length && <Menu className="learning-chat-picker learning-chat-reasoning" panelClassName="learning-chat-menu" screenActive={visible} resetKey={panel.active}
                label={<><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1.9a4.2 4.2 0 0 0-2.55 7.55c.45.35.7.85.7 1.4v.6h3.7v-.6c0-.55.25-1.05.7-1.4A4.2 4.2 0 0 0 8 1.9ZM6.4 13.9h3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg><span className="learning-chat-picker-label">{reasoning ? REASONING_LABELS[reasoning] : 'Default'}</span></>}
                ariaLabel="Reasoning for this chat" title="How hard it thinks before answering" align="left" side="above" disabled={busy || answering}
                items={[{ id: 'default', label: 'Default', hint: "the model’s own", checked: reasoning === null, onSelect: () => panel.setSelection({ model, reasoning: null }) },
                  ...efforts.map(effort => ({ id: effort, label: REASONING_LABELS[effort], checked: effort === reasoning, onSelect: () => panel.setSelection({ model, reasoning: effort }) }))]} />}
            </>}
            {configured && !modelEnabled && <span className="learning-chat-picker-label">Enable a model in Settings</span>}
            {answering ? (
              <button
                type="button"
                className="learning-chat-send"
                aria-label="Stop"
                title="Stop response"
                onClick={() =>
                  void client
                    .request(`/learning/chats/${view!.chat.id}/cancel`, 'POST', {})
                    .catch((e) => setError(e.message))
                }
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
                </svg>
              </button>
            ) : (
              <button
                className="learning-chat-send"
                aria-label="Send"
                title="Send message"
                disabled={!text.trim() || panel.sending || panel.loading || configured !== true || !modelEnabled}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 15V5m-5 5 5-5 5 5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  )
}

// Replacing an account/content binding unmounts all in-flight UI state.
export function ReadingChat(props: Parameters<typeof ReadingChatPanel>[0]) {
  return <ReadingChatPanel key={`${props.draftKey ?? ''}:${props.source.kind}:${props.source.id}`} {...props} />
}
