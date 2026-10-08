import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { ChatMessage, ChatQuote, QuoteSource, ReasoningEffort } from '@core/types'
import { modelReasoning } from '@core/ai'
import { CHATGPT_USAGE_URL } from './AISettings'
import ConnectionIcon, { PROVIDER_LABELS } from './ConnectionIcon'
import Tooltip from './Tooltip'
import { atBottom } from '@core/coach/scroll'
import { citeAnswer, shortTitle, type CitedSource } from '@core/sidechat/citations'
import { REASONING_LABELS, webSearchFor } from '@core/sidechat/models'
import { MAX_MESSAGE_CHARS } from '@core/sidechat/thread'
import Html from './Html'
import { useAutoGrow } from '../sidechat/useAutoGrow'
import type { ChatPanel } from '../sidechat/useChat'
import Menu from './Menu'
import ChatTabTitle from './ChatTabTitle'
import ChatMessageMeta from './ChatMessageMeta'

interface Props {
  panel: ChatPanel
  variant?: 'lesson' | 'project' | 'authoring'
  storageKey?: string
  /** What the learner highlighted - in the lesson or in an answer - waiting to be asked about. */
  quote: ChatQuote | null
  onQuoteUsed: () => void
  onClose?: () => void
  /** Takes you to settings. The panel never learns what a Route is. */
  onAddKey: () => void
}

const MIN_WIDTH = 320
/** How much of the lesson column must survive a drag. */
const MIN_CONTENT = 320
/** The count appears once a message is this close to the limit, and not before. */
const COUNT_FROM = MAX_MESSAGE_CHARS * 0.8

/** What an attached passage is called, by where it was highlighted. */
const QUOTE_LABEL: Record<QuoteSource, string> = { lesson: 'From the lesson', answer: 'From an answer', preview: 'From the preview' }

/** Only the ends of the scale need saying; the middle explains itself. */
const REASONING_HINTS: Partial<Record<ReasoningEffort, string>> = { none: 'fastest', xhigh: 'slowest' }

/** A chat with nothing said in it yet has no title, so say where it started. */
function tabLabel(title: string, fallback: string): string {
  const text = title.trim()
  if (!text) return fallback
  return text.length > 26 ? `${text.slice(0, 26)}…` : text
}

function Answer({ text }: { text: string }): JSX.Element {
  return <Html className="chat-body prose" source={text} />
}

function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToolIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A bulb: what the reasoning picker is about, so its label can be one word. */
function ThinkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M8 1.9a4.2 4.2 0 0 0-2.55 7.55c.45.35.7.85.7 1.4v.6h3.7v-.6c0-.55.25-1.05.7-1.4A4.2 4.2 0 0 0 8 1.9ZM6.4 13.9h3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A globe: the composer's sign that a question may search the web. */
function GlobeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6.1" />
        <path d="M1.9 8h12.2M8 1.9c1.7 1.7 2.5 3.8 2.5 6.1S9.7 12.4 8 14.1M8 1.9C6.3 3.6 5.5 5.7 5.5 8s.8 4.4 2.5 6.1" />
      </g>
    </svg>
  )
}

/**
 * Icons already fetched, by answer, for the life of the window. A tab that
 * comes back up redraws its sources with their icons at once, rather than
 * flashing letter tiles while main answers from its own cache.
 */
const sourceIcons = new Map<string, Record<string, string | null>>()

/** A letter tile's colour, from the site's name: the same site always looks the same. */
function hueOf(host: string): number {
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The site's favicon once main has it, and a letter tile until then - or for
 * good, if it has none. Same box either way, so nothing moves when it lands.
 */
function SourceIcon({ host, icon }: { host: string; icon: string | null | undefined }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (icon && !broken) {
    return <img className="source-icon" src={icon} alt="" width={16} height={16} onError={() => setBroken(true)} />
  }
  return (
    <span className="source-icon letter" style={{ '--hue': hueOf(host) } as CSSProperties} aria-hidden="true">
      {(host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()}
    </span>
  )
}

/**
 * The pages an answer leaned on, numbered to match the markers in its text.
 * `data-ask="none"` keeps a selection in here from being offered as a quote of
 * the answer: these are the app's labels, not anything the model said.
 * A click opens the page in the browser, through App's handler for every link.
 */
function Sources({ chatId, seq, sources }: { chatId: string; seq: number; sources: CitedSource[] }): JSX.Element {
  const cacheKey = `${chatId}:${seq}`
  const [icons, setIcons] = useState<Record<string, string | null>>(() => sourceIcons.get(cacheKey) ?? {})
  useEffect(() => {
    if (sourceIcons.has(cacheKey)) return
    let cancelled = false
    window.opencourse
      .getChatSourceIcons(chatId, seq)
      .then((found) => {
        // All letter tiles may be an outage rather than an answer, so that is
        // not kept: the next time this answer comes up, it asks again.
        if (Object.values(found).some(Boolean)) sourceIcons.set(cacheKey, found)
        if (!cancelled) setIcons(found)
      })
      .catch(() => {
        // Letter tiles are the fallback for every failure; there is nothing to report.
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, chatId, seq])
  return (
    <nav className="chat-sources" data-ask="none" aria-label="Sources">
      <div className="chat-sources-label">Sources</div>
      <ol>
        {sources.map((source) => (
          <li key={source.n}>
            <a className="chat-source" href={source.url} title={source.title ? `${source.title}\n${source.url}` : source.url}>
              <span className="chat-source-n">{source.n}</span>
              <SourceIcon host={source.host} icon={icons[siteOf(source.url)]} />
              <span className="chat-source-title">{shortTitle(source.title, source.url)}</span>
              <span className="chat-source-host">{source.host}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * A finished answer. Its citations become numbered markers in the text and a
 * list under it - decided here, from what was stored (core/sidechat/citations.ts).
 * `data-ask` is on the answer's text alone, so a drag that runs on into the
 * sources is not offered as a quote of what the model said.
 */
function AnswerTurn({ chatId, message }: { chatId: string | null; message: ChatMessage }): JSX.Element {
  const cited = useMemo(() => citeAnswer(message.text, message.citations), [message.text, message.citations])
  return (
    <div className="chat-turn assistant">
      <div className="chat-answer" data-ask="answer">
        <Answer text={cited.markdown} />
      </div>
      {(message.status === 'stopped' || message.status === 'failed') && <p className="meta" data-ask="none">{message.status === 'stopped' ? 'Stopped · partial response' : 'Response failed · partial text preserved'}</p>}
      {chatId && cited.sources.length > 0 && <Sources chatId={chatId} seq={message.seq} sources={cited.sources} />}
      <ChatMessageMeta message={message} />
    </div>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  )
}

/**
 * `fresh` is a message said while you were watching, and it arrives rather
 * than appears. `chatId` is the side chat's, for an answer's sources; a
 * project chat has none to show.
 */
function Message({ message, fresh, chatId }: { message: ChatMessage; fresh: boolean; chatId: string | null }): JSX.Element | null {
  // A lesson snapshot is not something anyone said. It is shown as a divider so
  // the learner can see where the chat changed lesson, and nothing more - the
  // text itself is the whole lesson and would bury the conversation.
  if (message.role === 'context') {
    return (
      <div className={`chat-context${fresh ? ' enter' : ''}`} title={message.authoring ? "The current course selection was supplied to the assistant here" : message.project ? "The project requirements were given to the assistant here" : "The lesson was given to the assistant here"}>
        {message.authoring ? `Working on: ${message.authoring.label}` : message.project ? 'Project requirements supplied' : message.lessonTitle ? `Now reading: ${message.lessonTitle}` : 'Lesson context'}
      </div>
    )
  }
  // Never animated: a finished answer replaces the partial that streamed it,
  // and fading in text that was already on screen reads as a flicker.
  // `data-ask` is what lets a passage of it be highlighted and asked about; the
  // lesson listens for that (routes/Lesson.tsx), and the partial never has it.
  if (message.role === 'assistant') return <AnswerTurn chatId={chatId} message={message} />
  // A bubble on the right, so scrolling back through a long answer you can
  // still find where each question was asked without reading for it.
  return (
    <div className={`chat-turn user${fresh ? ' enter' : ''}`}>
      <div className="chat-bubble">
        {message.quote && (
          <blockquote className="chat-quote" title={QUOTE_LABEL[message.quote.from]}>
            {message.quote.text}
          </blockquote>
        )}
        <div className="chat-body">{message.text}</div>
      </div>
      <ChatMessageMeta message={message} />
    </div>
  )
}

export default function ChatPanelView({
  panel,
  variant = 'lesson',
  quote,
  onQuoteUsed,
  onClose,
  onAddKey,
  storageKey
}: Props): JSX.Element {
  // The lesson column and the sidebar are the only things it has to leave
  // room for: the editor takes the whole workspace, so the two are never
  // open at once.
  const [width, setWidth] = useState(() =>
    Math.max(MIN_WIDTH, Math.min(420, window.innerWidth - MIN_CONTENT - 268))
  )
  const [draft, setDraft] = useState(() => { try { return storageKey ? localStorage.getItem(`${storageKey}:composer`) ?? '' : '' } catch { return '' } })
  useEffect(() => { if (storageKey) { try { localStorage.setItem(`${storageKey}:composer`, draft) } catch { /* Optional. */ } } }, [storageKey, draft])
  const [historyOpen, setHistoryOpen] = useState(false)

  const scroller = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const twin = useRef<HTMLTextAreaElement | null>(null)
  useAutoGrow(field, twin, draft)

  const answering = panel.activeId !== null && panel.busy.has(panel.activeId)

  // What was already in a chat when its tab came up is history and appears as
  // it is; only what is said while you watch animates in. Remembered per chat,
  // so switching tabs never replays a whole conversation.
  const thread = panel.thread
  const displayedMessages = useMemo(() => {
    let lastTarget = ''
    return thread?.messages.filter(message => {
      if (message.role !== 'context' || !message.authoring) return true
      const target = JSON.stringify([message.authoring.target, message.authoring.label])
      const changed = target !== lastTarget
      lastTarget = target
      return changed
    })
  }, [thread])
  const [settled, setSettled] = useState<{ chatId: string; upTo: number } | null>(null)
  if (thread && settled?.chatId !== thread.chat.id) {
    setSettled({ chatId: thread.chat.id, upTo: thread.messages.at(-1)?.seq ?? -1 })
  }

  // Which model this tab answers with, and what may be picked instead. A model
  // already chosen but missing from the list is kept at the front, so changing
  // tabs retains an unavailable individual selection until the learner chooses
  // an available model. Main has already reset models removed from the allowlist.
  const active = panel.tabs.find((t) => t.id === panel.activeId)
  const provider = active?.provider ?? panel.provider
  const connectionLabel = `${PROVIDER_LABELS[provider]}${panel.connection.account ? ` (${panel.connection.account})` : ''}`
  const model = active?.model || null
  const reasoning = active?.reasoning ?? null
  const modelChoices = useMemo(() => {
    const ids = panel.models.map((m) => m.id)
    return model && !ids.includes(model) ? [model, ...ids] : ids
  }, [panel.models, model])
  // The levels this model takes. None at all hides the picker: the request
  // then says nothing about reasoning, which every model accepts.
  const efforts = useMemo(() => (model ? modelReasoning(model, panel.models) : []), [model, panel.models])
  // Whether a question sent now may search: Settings said yes, and this model
  // at this level takes the tool. The model still decides whether it does.
  const searchable = model !== null && webSearchFor(model, reasoning)

  // The panel opens with no tab up, so put one there rather than showing an
  // empty shell: the last chat about this course, or a new one if there is none.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || panel.loading || panel.activeId) return
    started.current = true
    void panel.resume()
  }, [panel])

  useEffect(() => {
    field.current?.focus()
  }, [panel.activeId, quote])

  // Follow the answer as it grows, the way a terminal follows output.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [panel.thread, panel.streaming])

  // The composer grows as you write, and it grows into this column from below.
  // If you were reading the latest line, keep it in view rather than letting
  // the box slide over it; if you had scrolled up, you asked to be left alone.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let following = true
    const onScroll = (): void => {
      following = atBottom(el)
    }
    const observer = new ResizeObserver(() => {
      if (following) el.scrollTop = el.scrollHeight
    })
    el.addEventListener('scroll', onScroll, { passive: true })
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])

  const startWidthDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const onMove = (move: PointerEvent): void => {
      // Measured from the right edge, so the lesson column gives way first -
      // and never past the point where it stops being readable.
      const room = window.innerWidth - MIN_CONTENT
      setWidth(Math.max(MIN_WIDTH, Math.min(room, window.innerWidth - move.clientX)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || answering || panel.sendBlocked) return
    const attached = quote ?? undefined
    if (await panel.send(text, attached)) {
      setDraft('')
      if (attached) onQuoteUsed()
    }
  }, [draft, answering, quote, onQuoteUsed, panel])

  return (
    <aside className={`sidechat${variant === 'authoring' ? ' authoring-chat' : ''}`} style={{ width, flex: '0 1 auto' }}>
      <div className="sidechat-grip" onPointerDown={startWidthDrag} role="separator" aria-orientation="vertical" />

      <div className="sidechat-head">
        <strong>{variant === 'authoring' ? 'Course assistant' : variant === 'project' ? 'Project assistant' : 'Ask about this lesson'}</strong>
        {onClose && <button className="ghost sidechat-close" onClick={onClose} title="Close the side chat">
          ✕
        </button>}
      </div>

      <div className="sidechat-tabs">
        {panel.tabs.map((tab) => (
          <span
            key={tab.id}
            className={`sidechat-tab${tab.id === panel.activeId ? ' active' : ''}`}
            onClick={() => panel.setActive(tab.id)}
            title={tab.title || 'A new chat'}
          >
            {panel.busy.has(tab.id) && <span className="sidechat-dot" aria-label="answering" />}
            <ChatTabTitle title={tabLabel(tab.title, 'New chat')} />
            <button
              className="sidechat-tab-close"
              title="Close this tab (the chat is kept)"
              onClick={(e) => {
                e.stopPropagation()
                panel.close(tab.id)
              }}
            >
              ✕
            </button>
          </span>
        ))}
        <button className="sidechat-new" title="Start another chat" onClick={() => void panel.startNew()}>
          ＋
        </button>
        <span className="spacer" />
        <button
          className={`sidechat-history-toggle${historyOpen ? ' active' : ''}`}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          History
        </button>
      </div>

      {historyOpen && (
        <div className="sidechat-history">
          {panel.chats.length === 0 && <div className="meta">No conversations yet.</div>}
          {panel.chats.map((chat) => (
            <div key={chat.id} className="sidechat-history-row" onClick={() => panel.open(chat.id)}>
              <div>
                <div>{chat.title || 'A new chat'}</div>
                <div className="meta">
                  {chat.historyLabel ?? (chat.startedIn ? 'Conversation' : 'Project')} · {chat.messages} message
                  {chat.messages === 1 ? '' : 's'}
                </div>
              </div>
              <button
                className="ghost"
                title="Delete this chat for good"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm('Delete this chat? This cannot be undone.')) void panel.remove(chat.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {!panel.ready && (
        <div className="sidechat-note">
          <span>{panel.connection.message ?? `Connect ${PROVIDER_LABELS[panel.provider]} in Settings.`}</span>
          <button onClick={onAddKey}>Open Settings</button>
        </div>
      )}

      <div className="sidechat-scroll scroll" ref={scroller}>
        {/* Shown with or without a key: a panel that is blank and silent reads
            as broken, and the guidance is true either way. */}
        {thread?.messages.length === 0 && (
          <div className="sidechat-empty">
            <p>{variant === 'authoring' ? 'Describe the course you want, or ask to edit any part of this course.' : variant === 'project' ? 'Ask for clarification or feedback on your project.' : 'Ask anything about this lesson.'}</p>
            <p className="meta">
              {variant === 'authoring' ? 'Your selected block is included automatically. Changes appear in the preview as the assistant edits your draft.' : variant === 'project' ? 'The project definition and deliverables are included automatically. Files the assistant reads from this project folder are sent to OpenAI. The assistant can inspect text files and cannot run code.' : 'The whole lesson goes to the assistant with your first question. Highlight a passage first and it will be attached to what you ask.'}
            </p>
          </div>
        )}
        {displayedMessages?.map((message) => (
          <Message
            key={message.seq}
            message={message}
            fresh={settled?.chatId === thread!.chat.id && message.seq > settled.upTo}
            chatId={variant === 'lesson' ? thread!.chat.id : null}
          />
        ))}
        {panel.streaming !== null && (
          <div className={`chat-turn assistant partial${panel.streaming === '' ? ' thinking' : ''}`}>
            {panel.streaming ? (
              <Answer text={panel.streaming} />
            ) : (
              <span className="chat-typing" role="status" aria-label="Thinking">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        )}
        {panel.activity && <div className="project-tool-activity meta" role="status"><ToolIcon /><span>{panel.activity}</span></div>}
        {panel.error && <div className="sidechat-error">{panel.error} <button className="ghost" onClick={onAddKey}>Settings</button>{panel.provider === 'chatgpt' && <button className="ghost" onClick={() => void window.opencourse.openExternal(CHATGPT_USAGE_URL)}>Manage usage ↗</button>}</div>}
      </div>

      <div className="sidechat-composer">
        {/* The whole box is the field to a pointer - a press on its padding or
            its footer lands in the text - except for the controls inside it. */}
        <div
          className="sidechat-box"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button, textarea, blockquote, [role=menu], [tabindex]')) return
            e.preventDefault()
            field.current?.focus()
          }}
        >
          {quote && (
            <div className="sidechat-quote">
              <div className="sidechat-quote-head">
                <span className="sidechat-quote-label">{QUOTE_LABEL[quote.from]}</span>
                <button className="ghost" title="Do not attach this" onClick={onQuoteUsed}>
                  ✕
                </button>
              </div>
              <blockquote>{quote.text}</blockquote>
            </div>
          )}
          <div className="sidechat-field">
            <textarea
              ref={field}
              className="sidechat-input"
              value={draft}
              disabled={!active}
              rows={1}
              maxLength={MAX_MESSAGE_CHARS}
              placeholder={quote ? 'Ask about the highlighted passage…' : variant === 'authoring' ? 'Create or edit this course…' : variant === 'project' ? 'Ask about your project…' : 'Ask about this lesson…'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, because this is a chat. A newline is still one
                // modifier away, which is what the multi-line box is for - and
                // an Enter that is confirming an input method's candidate is
                // not a send at all.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <textarea
              ref={twin}
              className="sidechat-input sidechat-twin"
              value={draft}
              rows={1}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          {/* Under the field rather than in the header, the way Copilot does
              it: what answers is a property of the message you are writing,
              and a picker in the header read as a setting of the panel. */}
          <div className="sidechat-actions">
            <Tooltip label={connectionLabel}><span className="sidechat-connection" role="img" aria-label={connectionLabel} tabIndex={0}><ConnectionIcon provider={provider} /></span></Tooltip>
            {model !== null && (
              <Menu
                className="sidechat-model"
                disabled={answering}
                title="Which model answers"
                align="left"
                label={<span className="sidechat-picker-label">{model}</span>}
                items={modelChoices.map((id) => ({
                  id,
                  label: id,
                  checked: id === model,
                  onSelect: () => void panel.setModel(id)
                }))}
              />
            )}
            {model !== null && efforts.length > 0 && (
              <Menu
                className="sidechat-reasoning"
                disabled={answering}
                title="How hard it thinks before answering"
                align="left"
                label={
                  <>
                    <ThinkIcon />
                    <span className="sidechat-picker-label">{reasoning ? REASONING_LABELS[reasoning] : 'Default'}</span>
                  </>
                }
                items={[
                  {
                    id: 'default',
                    label: 'Default',
                    hint: "the model's own",
                    checked: reasoning === null,
                    onSelect: () => void panel.setReasoning(null)
                  },
                  ...efforts.map((effort) => ({
                    id: effort,
                    label: REASONING_LABELS[effort],
                    hint: REASONING_HINTS[effort],
                    checked: reasoning === effort,
                    onSelect: () => void panel.setReasoning(effort)
                  }))
                ]}
              />
            )}
            {variant === 'lesson' && panel.webSearch && model !== null && (
              <span
                className={`sidechat-web${searchable ? '' : ' off'}`}
                role="img"
                aria-label={searchable ? 'Can search the web' : 'Cannot search the web with this model'}
                title={
                  searchable
                    ? 'Can search the web when a question needs it'
                    : reasoning === 'minimal'
                      ? `${model} cannot search the web at Minimal reasoning`
                      : `${model} cannot search the web`
                }
              >
                <GlobeIcon />
                <span className="sidechat-picker-label">Web</span>
              </span>
            )}
            <span className="spacer" />
            {draft.length >= COUNT_FROM && (
              <span className={`sidechat-count${draft.length >= MAX_MESSAGE_CHARS ? ' full' : ''}`}>
                {draft.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
              </span>
            )}
            {answering ? (
              <button key="stop" className="sidechat-send stop" title="Stop the answer" aria-label="Stop" onClick={panel.stop}>
                <StopIcon />
              </button>
            ) : (
              <button
                key="send"
                className="sidechat-send"
                title="Send (↩) · ⇧↩ for a new line"
                aria-label="Send"
                disabled={!draft.trim() || !panel.activeId || panel.sendBlocked}
                onClick={() => void submit()}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
