/**
 * Everything the side chat panel knows, so the panel itself is just markup.
 *
 * The one piece of real machinery here is how a streaming answer reaches the
 * screen. Deltas arrive over IPC a few characters at a time, and calling
 * setState on each one spends the whole frame budget re-rendering a paragraph
 * that is still growing. So deltas land in a ref and a timer copies the buffer
 * into state while an answer is in flight - the same arrangement CoachSession
 * uses for a live transcript, for the same reason.
 *
 * Answers do not stop arriving when you switch tabs: main keeps streaming, and
 * the finished reply is in the database either way. A background chat's deltas
 * are simply not rendered, and its thread is re-read when it finishes.
 *
 * A new tab is a draft: it exists here and nowhere else - no row, no history
 * entry, no saved tab - until its first message is sent. Only then is the chat
 * created, with whatever model and reasoning the draft was given, and if main
 * refuses that first message the chat goes again. Creating on open left an
 * empty "A new chat" in the history every time the last tab was closed.
 *
 * Each conversation can use its own connection - the key or the subscription -
 * chosen from the composer, without changing Settings' default. So the panel
 * keeps the model list of both, and shows the one the active tab uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AIConnection, AIProvider, AIScope, ChatDefaults, ChatPickerModels, ChatSendResult, ChatLessonRef, ChatModel, ChatQuote, ChatSummary, ChatMessage, ReasoningEffort } from '@core/types'
import { modelReasoning } from '@core/ai'
import { MAX_MESSAGE_CHARS } from '@core/sidechat/thread'

/** Fast enough to read as typing, slow enough to cost nothing. */
const TICK_MS = 100
const DRAFT = 'draft:'
let drafted = 0
/** A tab whose chat does not exist yet. */
export const isDraft = (id: string | null | undefined): boolean => !!id?.startsWith(DRAFT)

export type PanelSummary = Omit<ChatSummary, 'startedIn'> & { startedIn?: ChatLessonRef | null; historyLabel?: string }
export interface PanelThread { chat: PanelSummary; messages: ChatMessage[] }
interface PendingMessage { chat: PanelSummary; message: ChatMessage; afterSeq: number }
export interface ChatPanel {
  chats: PanelSummary[]
  tabs: PanelSummary[]
  activeId: string | null
  thread: PanelThread | null
  /** The answer being streamed into the active chat, if one is. */
  streaming: string | null
  busy: ReadonlySet<string>
  error: string | null
  models: ChatModel[]
  /** Whether Settings lets a question search the web. The model decides whether it does. */
  webSearch: boolean
  ready: boolean
  /** The connection the active tab uses: its own choice, or the default. */
  provider: AIProvider
  connection: AIConnection
  /** Settings' connection for this feature, which a tab follows unless it chose another. */
  defaultProvider: AIProvider
  /** Both connections, so the menu can say which is set up. */
  connections: Partial<Record<AIProvider, AIConnection>>
  loading: boolean
  activity: string | null
  sendBlocked?: boolean
  setActive: (id: string) => void
  open: (id: string) => void
  close: (id: string) => void
  startNew: () => Promise<void>
  /** Re-open the most recent chat about this course, or start the first one. */
  resume: () => Promise<void>
  remove: (id: string) => Promise<void>
  send: (text: string, quote?: ChatQuote, review?: boolean) => Promise<boolean>
  stop: () => void
  setModel: (model: string) => Promise<void>
  /** Null is the model's own default. */
  setReasoning: (reasoning: ReasoningEffort | null) => Promise<void>
  /** Use this connection for the active conversation only; Settings stays as it is. */
  setProvider: (provider: AIProvider) => Promise<void>
}

export interface ChatTransport {
  list: () => Promise<PanelSummary[]>
  get: (id: string) => Promise<PanelThread | null>
  create: () => Promise<PanelSummary>
  remove: (id: string) => Promise<void>
  send: (id: string, text: string, quote?: ChatQuote, review?: boolean) => Promise<ChatSendResult>
  cancel: (id: string) => Promise<void>
  setModel: (id: string, model: string) => Promise<PanelSummary>
  setReasoning: (id: string, reasoning: ReasoningEffort | null) => Promise<PanelSummary>
  /** Null follows Settings' default again. */
  setProvider: (id: string, provider: AIProvider | null) => Promise<PanelSummary>
  onDelta: (handler: (id: string, chunk: string) => void) => () => void
  onDone: (handler: (id: string) => void) => () => void
  onTitle: (handler: (id: string, title: string) => void) => () => void
  onError: (handler: (id: string, error: string) => void) => () => void
  onActivity: (handler: (id: string, activity: string) => void) => () => void
}
function savedPanel(key?: string): { tabs: string[]; active: string | null } {
  try {
    const value = key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null
    return { tabs: Array.isArray(value?.tabs) ? value.tabs.filter((id: unknown) => typeof id === 'string').slice(0, 200) : [], active: typeof value?.active === 'string' ? value.active : null }
  } catch { return { tabs: [], active: null } }
}
export function useChatPanel(courseId: string, lesson?: ChatLessonRef, projectModuleSlug?: string, visible = true): ChatPanel {
  const transport = useMemo(() => {
    const api = window.opencourse
    const target = { courseId, moduleId: projectModuleSlug ?? '' }
    return projectModuleSlug ? {
      list: () => api.listProjectChats(target), get: api.getProjectChat,
      create: () => api.createProjectChat(target), remove: api.deleteProjectChat,
      send: api.sendProjectMessage, cancel: api.cancelProjectChat,
      setModel: api.setProjectChatModel, setReasoning: api.setProjectChatReasoning, setProvider: api.setProjectChatProvider,
      onDelta: api.onProjectChatDelta, onDone: api.onProjectChatDone, onTitle: api.onProjectChatTitle, onError: api.onProjectChatError,
      onActivity: api.onProjectChatActivity
    } : {
      list: () => api.listChats(courseId), get: api.getChat,
      create: () => api.createChat(courseId, lesson!), remove: api.deleteChat,
      send: (id: string, text: string, quote?: ChatQuote, _review?: boolean) => api.sendChatMessage(id, text, quote, lesson!),
      cancel: api.cancelChat, setModel: api.setChatModel, setReasoning: api.setChatReasoning, setProvider: api.setChatProvider,
      onDelta: api.onChatDelta, onDone: api.onChatDone, onTitle: api.onChatTitle, onError: api.onChatError,
      onActivity: api.onChatActivity
    }
  }, [courseId, lesson?.moduleId, lesson?.lessonId, projectModuleSlug])
  return useConversationPanel(transport, projectModuleSlug ? 'project' : 'chat', visible)
}

export function useConversationPanel(transport: ChatTransport, scope: AIScope, visible = true, storageKey?: string): ChatPanel {
  const [activity, setActivity] = useState<string | null>(null)
  const [chats, setChats] = useState<PanelSummary[]>([])
  // Restore only after the course's chat list validates saved IDs. Never load
  // a stale or unrelated thread from local storage during the initial render.
  const [tabIds, setTabIds] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [thread, setThread] = useState<PanelThread | null>(null)
  const [streaming, setStreaming] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // The picker list of each connection: the default's, and the other one's for
  // a conversation pinned to it.
  const [catalogs, setCatalogs] = useState<Partial<Record<AIProvider, ChatPickerModels>>>({})
  const [defaultProvider, setDefaultProvider] = useState<AIProvider>('apiKey')
  const [webSearch, setWebSearch] = useState(false)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  // Tabs with no history entry yet: drafts, and a draft's chat while its first
  // message is on its way. The history list is `chats` and never sees these.
  const [unlisted, setUnlisted] = useState<ReadonlyMap<string, PanelSummary>>(new Map())
  const unlistedRef = useRef(unlisted)
  const defaults = useRef<ChatDefaults & { provider: AIProvider }>({ model: '', reasoning: null, provider: 'apiKey' })
  const sending = useRef(false)
  const [pendingMessages, setPendingMessages] = useState<ReadonlyMap<string, PendingMessage>>(new Map())
  const pendingRef = useRef(pendingMessages)
  const keepPending = useCallback((change: (next: Map<string, PendingMessage>) => void): void => {
    const next = new Map(pendingRef.current); change(next)
    pendingRef.current = next; setPendingMessages(next)
  }, [])

  /** Live delta buffers, per chat. Only the active one is ever rendered. */
  const buffers = useRef(new Map<string, string>())
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  // Read by `close`, which needs the current tabs without depending on them and
  // must not reach for them inside another setState updater.
  const tabIdsRef = useRef<string[]>([])
  tabIdsRef.current = tabIds
  const keepUnlisted = useCallback((change: (next: Map<string, PanelSummary>) => void): void => {
    const next = new Map(unlistedRef.current); change(next)
    unlistedRef.current = next; setUnlisted(next)
  }, [])
  const draftOf = useCallback((id: string, config?: Partial<PanelSummary>): PanelSummary => {
    const at = new Date().toISOString()
    return { id, courseId: '', title: '', messages: 0, createdAt: at, updatedAt: at, ...defaults.current, ...config }
  }, [])

  const loadThread = useCallback(async (id: string): Promise<void> => {
    if (isDraft(id)) return
    try {
      const next = await transport.get(id)
      const pending = pendingRef.current.get(id)
      if (next) {
        setChats(current => current.map(chat => chat.id === id ? next.chat : chat))
        keepUnlisted(current => { if (current.has(id)) current.set(id, next.chat) })
        if (pending && next.messages.some(message => message.role === 'user' && message.seq > pending.afterSeq && message.text === pending.message.text)) keepPending(messages => messages.delete(id))
      }
      if (activeRef.current === id) setThread(next)
    } catch (err) { if (activeRef.current === id) setError((err as Error).message) }
  }, [transport, keepPending, keepUnlisted])

  const refreshList = useCallback(async (): Promise<void> => {
    try { setChats(await transport.list()) } catch (err) { setError((err as Error).message) }
  }, [transport])

  const refreshKey = useCallback(async (): Promise<void> => {
    const result = await window.opencourse.listChatModels(scope)
    const provider = result.defaultProvider ?? result.connection?.provider ?? result.provider ?? 'apiKey'
    const other: AIProvider = provider === 'apiKey' ? 'chatgpt' : 'apiKey'
    // The other connection's list is only for a conversation pinned to it, so
    // trouble reaching it is that conversation's to report, not the panel's.
    const second = await window.opencourse.listChatModels(scope, other).catch(() => null)
    const lists: Partial<Record<AIProvider, ChatPickerModels>> = { [provider]: result, ...(second ? { [other]: second } : {}) }
    setCatalogs(lists); setDefaultProvider(provider); setWebSearch(result.webSearch)
    // What main would give a chat created now. A draft keeps a model it was
    // given only while its connection still offers that model, as a stored chat does.
    defaults.current = { ...(result.defaults ?? { model: '', reasoning: null }), provider }
    keepUnlisted(next => {
      for (const [id, chat] of next) {
        if (!isDraft(id)) continue
        const own = chat.pinnedProvider ?? provider
        const list = lists[own]
        if (chat.model && chat.provider === own && list?.models.some(m => m.id === chat.model)) continue
        next.set(id, chat.pinnedProvider && list
          ? { ...chat, ...(list.defaults ?? { model: '', reasoning: null }), provider: own }
          : { ...chat, ...defaults.current, pinnedProvider: undefined })
      }
    })
    await refreshList()
    if (activeRef.current) await loadThread(activeRef.current)
  }, [scope, refreshList, loadThread, keepUnlisted])

  useEffect(() => { if (visible) void refreshKey().catch((error: Error) => setError(error.message)) }, [visible, refreshKey, version])
  useEffect(() => window.opencourse.onAIChanged(() => setVersion(value => value + 1)), [])
  useEffect(() => { void refreshList(); if (activeRef.current) void loadThread(activeRef.current) }, [version, refreshList, loadThread])

  /* --- first load ------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const list = await transport.list()
        if (cancelled) return
        setChats(list)
        if (storageKey) {
          const valid = new Set(list.map(chat => chat.id)), saved = savedPanel(storageKey)
          setTabIds(saved.tabs.filter(id => valid.has(id)))
          setActiveId(saved.active && valid.has(saved.active) ? saved.active : null)
        }
      } catch (err) { if (!cancelled) setError((err as Error).message) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => {
      cancelled = true
    }
  }, [transport, storageKey])

  useEffect(() => {
    if (!storageKey || loading) return
    const saved = tabIds.filter(id => !isDraft(id))
    try { localStorage.setItem(storageKey, JSON.stringify({ tabs: saved, active: isDraft(activeId) ? null : activeId })) } catch { /* Storage is optional. */ }
  }, [storageKey, loading, tabIds, activeId])

  useEffect(() => {
    if (activeId && !isDraft(activeId)) void loadThread(activeId)
    else setThread(null)
  }, [activeId, loadThread])

  /* --- the stream ------------------------------------------------------- */
  useEffect(() => {
    const offDelta = transport.onDelta((chatId, chunk) => {
      buffers.current.set(chatId, (buffers.current.get(chatId) ?? '') + chunk)
    })
    const offDone = transport.onDone((chatId) => {
      buffers.current.delete(chatId)
      if (activeRef.current === chatId) setActivity(null)
      setBusy((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
      if (activeRef.current === chatId) setStreaming(null)
      void loadThread(chatId)
      void refreshList()
    })
    const offError = transport.onError((chatId, message) => {
      buffers.current.delete(chatId)
      if (activeRef.current === chatId) setActivity(null)
      setBusy((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
      if (activeRef.current === chatId) {
        setStreaming(null)
        setError(message)
      }
      void loadThread(chatId)
      void refreshList()
    })
    const offActivity = transport.onActivity((id, message) => {
      if (activeRef.current === id) setActivity(message)
    })
    const offTitle = transport.onTitle((id, title) => {
      keepUnlisted(next => { const chat = next.get(id); if (chat) next.set(id, { ...chat, title }) })
      setChats(current => current.map(chat => chat.id === id ? { ...chat, title } : chat))
      setThread(current => current?.chat.id === id ? { ...current, chat: { ...current.chat, title } } : current)
      void refreshList()
    })
    return () => {
      offTitle()
      offActivity()
      offDelta()
      offDone()
      offError()
    }
  }, [loadThread, refreshList, transport, keepUnlisted])

  // The throttle: only runs while something is actually streaming.
  useEffect(() => {
    if (!busy.size) return
    const timer = window.setInterval(() => {
      const id = activeRef.current
      if (!id) return
      const buffered = buffers.current.get(id)
      if (buffered !== undefined) setStreaming(buffered)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [busy])

  /* --- what the panel can do -------------------------------------------- */
  const open = useCallback((id: string) => {
    const ids = tabIdsRef.current
    tabIdsRef.current = ids.includes(id) ? ids : [...ids, id]
    setTabIds(tabIdsRef.current)
    activeRef.current = id
    setActiveId(id)
    setThread(current => current?.chat.id === id ? current : null)
    setStreaming(buffers.current.get(id) ?? null)
    setActivity(null)
    setError(null)
  }, [])

  const startDraft = useCallback((): string => {
    const id = `${DRAFT}${Date.now().toString(36)}-${++drafted}`
    keepUnlisted(next => next.set(id, draftOf(id)))
    return id
  }, [keepUnlisted, draftOf])

  // Closing the last tab puts a draft in its place: there is always a tab,
  // and an untouched one costs nothing.
  const close = useCallback((id: string): void => {
    if (!tabIdsRef.current.includes(id)) return
    if (isDraft(id)) keepUnlisted(next => next.delete(id))
    const remaining = tabIdsRef.current.filter(tab => tab !== id)
    tabIdsRef.current = remaining
    setTabIds(remaining)
    if (!remaining.length) open(startDraft())
    else if (activeRef.current === id) open(remaining.at(-1)!)
  }, [keepUnlisted, open, startDraft])

  const startNew = useCallback(async (): Promise<void> => { open(startDraft()) }, [open, startDraft])

  /**
   * What the panel does when it is opened with no tab up: carry on with the most
   * recent chat about this course, and only start one when there is nothing to
   * carry on with. Always creating would leave a trail of empty chats in the
   * history for anyone who opened the panel and changed their mind.
   */
  const resume = useCallback(async (): Promise<void> => {
    try {
      const list = await transport.list()
      setChats(list)
      const recent = list[0]
      if (recent) open(recent.id)
      else await startNew()
    } catch (err) { setError((err as Error).message) }
  }, [transport, open, startNew])

  const remove = useCallback(
    async (id: string): Promise<void> => {
      close(id)
      if (isDraft(id)) return
      await transport.remove(id)
      await refreshList()
    },
    [close, refreshList, transport]
  )

  /** Put one tab's id in place of another's, wherever the panel holds it. */
  const replaceTab = useCallback((from: string, to: PanelSummary): void => {
    keepUnlisted(next => { next.delete(from); next.set(to.id, to) })
    tabIdsRef.current = tabIdsRef.current.map(id => id === from ? to.id : id)
    setTabIds(tabIdsRef.current)
    if (activeRef.current === from) {
      activeRef.current = to.id
      setActiveId(to.id)
      setThread({ chat: to, messages: [] })
    }
  }, [keepUnlisted])

  /** A draft's first message is what creates its chat, as the draft has it set up. */
  const materialize = useCallback(async (draft: PanelSummary): Promise<PanelSummary> => {
    let chat = await transport.create()
    try {
      if (draft.pinnedProvider) chat = await transport.setProvider(chat.id, draft.pinnedProvider)
      if (draft.model && draft.model !== chat.model) chat = await transport.setModel(chat.id, draft.model)
      if (draft.reasoning !== chat.reasoning) chat = await transport.setReasoning(chat.id, draft.reasoning)
    } catch (err) { await transport.remove(chat.id).catch(() => {}); throw err }
    replaceTab(draft.id, chat)
    return chat
  }, [transport, replaceTab])

  /** A first message main refused leaves nothing behind: the chat goes, the draft comes back. */
  const unmaterialize = useCallback(async (chat: string, draft: PanelSummary): Promise<void> => {
    try {
      if ((await transport.get(chat))?.messages.length) return
      await transport.remove(chat)
    } catch { return }
    replaceTab(chat, draft)
  }, [transport, replaceTab])

  const send = useCallback(
    async (text: string, quote?: ChatQuote, review = false): Promise<boolean> => {
      text = text.trim().slice(0, MAX_MESSAGE_CHARS)
      if (!activeId || sending.current || buffers.current.has(activeId) || !text) return false
      setError(null)
      const draft = isDraft(activeId) ? unlistedRef.current.get(activeId) : undefined
      const summary = draft ?? chats.find(chat => chat.id === activeId) ?? thread?.chat
      if (!summary) return false
      sending.current = true
      let sendingId = activeId
      const afterSeq = thread?.chat.id === activeId ? thread.messages.at(-1)?.seq ?? -1 : -1
      const optimistic: PendingMessage = {
        chat: summary, afterSeq,
        message: { role: 'user', text, seq: afterSeq + 1, at: new Date().toISOString(), ...(quote ? { quote } : {}) }
      }
      // Show the question and its title before creating a chat, flushing edits,
      // or preparing credentials. A thread read can replace it once saved.
      keepPending(next => next.set(sendingId, optimistic))
      buffers.current.set(sendingId, '')
      setStreaming('')
      setBusy((current) => new Set(current).add(sendingId))
      const clearPending = (): void => {
        keepPending(next => next.delete(sendingId))
        buffers.current.delete(sendingId)
        if (activeRef.current === sendingId) setStreaming(null)
        setBusy((current) => { const next = new Set(current); next.delete(sendingId); return next })
      }
      try {
        if (draft) {
          try {
            sendingId = (await materialize(draft)).id
            keepPending(next => { next.delete(draft.id); next.set(sendingId, optimistic) })
            buffers.current.delete(draft.id)
            buffers.current.set(sendingId, '')
            setBusy(current => { const next = new Set(current); next.delete(draft.id); next.add(sendingId); return next })
          } catch (err) { clearPending(); setError((err as Error).message); return false }
        }
        const undo = async (): Promise<void> => { if (draft) await unmaterialize(sendingId, draft) }
        let result
        try { result = await transport.send(sendingId, text, quote, review) }
        catch (err) { clearPending(); await undo(); setError((err as Error).message); return false }
        if (result.status !== 'ok') { clearPending(); await undo() }
        if (result.status === 'connection-required') {
          await refreshKey()
          setError(result.message)
          return false
        }
        if (result.status === 'no-key') {
          await refreshKey()
          setError('Chat needs an OpenAI key.')
          return false
        }
        if (result.status === 'busy') {
          setError('That chat is still answering. Wait for it, or stop it.')
          return false
        }
        if (result.status === 'failed') {
          setError(result.message)
          return false
        }
        await loadThread(sendingId)
        await refreshList()
        keepUnlisted(next => next.delete(sendingId))
        return true
      } finally { sending.current = false }
    },
    [activeId, chats, thread, transport, loadThread, refreshKey, refreshList, materialize, unmaterialize, keepUnlisted, keepPending]
  )

  const stop = useCallback(() => {
    if (activeId && !isDraft(activeId)) void transport.cancel(activeId)
  }, [activeId, transport])

  // What the active tab uses: its own connection's models, or the default's.
  const activeSummary = activeId ? (unlisted.get(activeId) ?? chats.find((chat) => chat.id === activeId) ?? (thread?.chat.id === activeId ? thread.chat : undefined)) : undefined
  const activeProvider: AIProvider = activeSummary?.provider ?? defaultProvider
  const models = useMemo(() => catalogs[activeProvider]?.models ?? [], [catalogs, activeProvider])
  const connection: AIConnection = catalogs[activeProvider]?.connection ?? { provider: activeProvider, ready: false }
  const connections = useMemo(() => {
    const found: Partial<Record<AIProvider, AIConnection>> = {}
    for (const [provider, list] of Object.entries(catalogs) as [AIProvider, ChatPickerModels][]) if (list.connection) found[provider] = list.connection
    return found
  }, [catalogs])

  /** A draft's settings are its own until it has a chat to keep them in. */
  const configureDraft = useCallback((id: string, model: string, reasoning: ReasoningEffort | null): void => {
    keepUnlisted(next => { const draft = next.get(id); if (draft) next.set(id, { ...draft, model, reasoning: reasoning && modelReasoning(model, models).includes(reasoning) ? reasoning : null }) })
  }, [keepUnlisted, models])

  const setModel = useCallback(
    async (model: string): Promise<void> => {
      if (!activeId) return
      if (isDraft(activeId)) { configureDraft(activeId, model, unlistedRef.current.get(activeId)?.reasoning ?? null); return }
      try { await transport.setModel(activeId, model) } catch (error) { setError((error as Error).message); return }
      await refreshList()
      await loadThread(activeId)
    },
    [activeId, loadThread, refreshList, transport, configureDraft]
  )

  const setReasoning = useCallback(
    async (reasoning: ReasoningEffort | null): Promise<void> => {
      if (!activeId) return
      if (isDraft(activeId)) { const draft = unlistedRef.current.get(activeId); if (draft) configureDraft(activeId, draft.model, reasoning); return }
      try {
        await transport.setReasoning(activeId, reasoning)
      } catch (err) {
        setError((err as Error).message)
      }
      await refreshList()
      await loadThread(activeId)
    },
    [activeId, refreshList, transport, loadThread, configureDraft]
  )

  /**
   * Choosing the default unpins the conversation, so it follows Settings from
   * then on; choosing the other connection pins it. Either way it takes that
   * connection's default model with it, since models belong to a connection.
   */
  const setProvider = useCallback(
    async (provider: AIProvider): Promise<void> => {
      if (!activeId) return
      const pinned = provider === defaultProvider ? null : provider
      setError(null)
      if (isDraft(activeId)) {
        const chosen = catalogs[provider]?.defaults ?? { model: '', reasoning: null }
        keepUnlisted(next => {
          const draft = next.get(activeId)
          if (!draft) return
          const { pinnedProvider: _previous, ...rest } = draft
          next.set(activeId, { ...rest, ...chosen, provider, ...(pinned ? { pinnedProvider: pinned } : {}) })
        })
        return
      }
      try { await transport.setProvider(activeId, pinned) } catch (err) { setError((err as Error).message); return }
      await refreshList()
      await loadThread(activeId)
    },
    [activeId, defaultProvider, catalogs, keepUnlisted, transport, refreshList, loadThread]
  )

  const tabs = useMemo(
    () => tabIds.map((id) => {
      const chat = chats.find(c => c.id === id) ?? unlisted.get(id)
      const pending = pendingMessages.get(id)
      return chat && pending && !chat.title ? { ...chat, title: pending.message.text.slice(0, 120) } : chat
    }).filter((c): c is PanelSummary => c !== undefined),
    [tabIds, chats, unlisted, pendingMessages]
  )
  const draft = activeId && isDraft(activeId) ? unlisted.get(activeId) : undefined
  const shown = useMemo(() => {
    const pending = activeId ? pendingMessages.get(activeId) : undefined
    const base = draft ? { chat: draft, messages: [] } : thread
    if (!pending) return base
    const chat = base?.chat ?? pending.chat
    return { chat: chat.title ? chat : { ...chat, title: pending.message.text.slice(0, 120) }, messages: [...(base?.messages ?? []), pending.message] }
  }, [activeId, draft, thread, pendingMessages])

  return {
    chats,
    tabs,
    activeId,
    thread: shown,
    streaming,
    busy,
    error,
    models,
    webSearch,
    ready: connection.ready,
    provider: activeProvider,
    connection,
    defaultProvider,
    connections,
    loading,
    activity,
    setActive: open,
    open,
    close,
    startNew,
    resume,
    remove,
    send,
    stop,
    setModel,
    setReasoning,
    setProvider
  }
}
