import { InterruptedConnection, NetworkRetriesExhausted, withNetworkRetries } from '../core/network-retry'
import { NETWORK_RETRIES } from '../core/chat-network'
import type { ChatTools } from '../core/chat-tools'
import { useEffect, useRef, useState } from 'react'
import type { ContentRef, LearningChat, LearningChatView, ServerAIDefaults } from '../core/learning/types'
import type { LearningClient } from './client'

const isDraft = (id: string) => id.startsWith('draft:')
const newDraft = () => `draft:${crypto.randomUUID()}`
interface Draft {
  text: string
  tools?: ChatTools
  selection?: ServerAIDefaults
  request?: { id: string; text: string; quote?: string; selection?: ServerAIDefaults }
}

/** Local tabs are separate from durable conversations, just like the desktop panel. */
export function useReadingTabs(client: LearningClient, source: ContentRef, storageKey: string, defaultSearch?: boolean, idempotentCreation = false) {
  const [initial] = useState(newDraft)
  const [tabs, setTabs] = useState([initial])
  const [active, setActive] = useState(initial)
  const [chats, setChats] = useState<LearningChat[]>([])
  const [views, setViews] = useState<Record<string, LearningChatView>>({})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const sendingRef = useRef<string | null>(null)
  const alive = useRef(true)
  const activeRef = useRef(active)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const lifetime = useRef(new AbortController())
  const fetching = useRef(new Map<string, Promise<void>>())
  const exhausted = useRef(new Set<string>())
  const [retries, setRetries] = useState<Record<string, number | null>>({})
  const reads = useRef(new Map<string, number>())
  const removed = useRef(new Set<string>())
  const panelKey = `${storageKey}:tabs`
  const view = views[active] ?? null
  const draft = drafts[active] ?? { text: '' }
  const busy = sending === active
  const answering = view?.messages.some((m) => m.status === 'running') ?? false

  // Capture defaults once for each unsent tab, including tabs opened before
  // the server settings arrived. No server row exists until the first send.
  useEffect(() => {
    if (!ready || defaultSearch === undefined) return
    setDrafts(current => {
      const missing = tabs.filter(id => isDraft(id) && !current[id]?.tools)
      if (!missing.length) return current
      const next = { ...current }
      for (const id of missing) next[id] = { ...(current[id] ?? { text: '' }), tools: { webSearch: defaultSearch } }
      return next
    })
  }, [ready, tabs, defaultSearch])
  async function setTools(tools: ChatTools) {
    if (sendingRef.current || answering || defaultSearch === undefined) return
    if (isDraft(active)) { setDrafts(d => ({ ...d, [active]: { ...d[active], text: d[active]?.text ?? '', tools } })); return }
    sendingRef.current = active
    setSending(active)
    try {
      const next = await client.request<LearningChatView>(`/learning/chats/${active}/tools`, 'PUT', tools)
      reads.current.set(active, (reads.current.get(active) ?? 0) + 1)
      accept(next)
    } catch (e) { if (alive.current) setError((e as Error).message) }
    finally { sendingRef.current = null; if (alive.current) setSending(null) }
  }
  function activate(id: string) {
    activeRef.current = id
    setActive(id)
    setError('')
  }
  function accept(next: LearningChatView) {
    if (!alive.current || removed.current.has(next.chat.id)) return
    setViews((v) => next.offline && v[next.chat.id] ? v : { ...v, [next.chat.id]: next })
    setChats((list) =>
      next.messages.length
        ? [next.chat, ...list.filter((c) => c.id !== next.chat.id)].sort((a, b) =>
            (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)
          )
        : list
    )
  }
  function recover<T>(operation: 'read' | 'send', id: string, request: () => Promise<T>) {
    const key = operation + ':' + id
    const signal = lifetime.current.signal
    return withNetworkRetries(request, signal, attempt => {
      if (!signal.aborted) setRetries(values => {
        const next = { ...values }
        if (attempt === null) delete next[key]
        else next[key] = attempt
        return next
      })
    }, undefined, `The server is still unavailable after ${NETWORK_RETRIES} retries. Reopen this chat or try again when the connection is stable.`)
  }
  function refresh(id: string): Promise<void> {
    const underway = fetching.current.get(id)
    if (underway) return underway
    if (exhausted.current.has(id)) return Promise.resolve()
    const revision = (reads.current.get(id) ?? 0) + 1
    reads.current.set(id, revision)
    const signal = lifetime.current.signal
    const load = recover('read', id, async () => {
      const next = await client.request<LearningChatView>(`/learning/chats/${id}`)
      signal.throwIfAborted()
      if (reads.current.get(id) === revision) accept(next)
      if (next.offline && (next.chat.running || sendingRef.current === id || (active === id && answering))) throw new InterruptedConnection('Showing the last received reply.')
    }).catch(e => {
      if (signal.aborted || !alive.current) return
      if (e instanceof NetworkRetriesExhausted) exhausted.current.add(id)
      if (activeRef.current === id && reads.current.get(id) === revision) setError((e as Error).message)
    }).finally(() => { if (fetching.current.get(id) === load) fetching.current.delete(id) })
    fetching.current.set(id, load)
    return load
  }
  useEffect(() => {
    alive.current = true
    lifetime.current = new AbortController()
    let current = true
    void recover('read', initial, () => client.request<{ chats: LearningChat[] }>(`/learning/chats?kind=${source.kind}&id=${source.id}`))
      .then(({ chats: list }) => {
        if (!current) return
        // Legacy clients created empty rows just by pressing +; keep them out of history.
        setChats(list.filter((c) => c.messages !== 0))
        let ids: string[] = [],
          selected: string | undefined,
          saved: unknown
        try {
          saved = JSON.parse(localStorage.getItem(panelKey) ?? 'null')
        } catch {}
        const panel = saved as { tabs?: unknown; active?: unknown } | null
        if (Array.isArray(panel?.tabs))
          ids = panel.tabs
            .filter((id): id is string => typeof id === 'string' && list.some((c) => c.id === id))
            .slice(0, 200)
        else {
          const recent = list.find((c) => c.messages !== 0)
          if (recent) ids = [recent.id]
        }
        if (!ids.length) ids = [initial]
        selected = typeof panel?.active === 'string' && ids.includes(panel.active) ? panel.active : ids[ids.length - 1]
        const restored: Record<string, Draft> = {}
        for (const id of ids) {
          try {
            const saved = JSON.parse(localStorage.getItem(`${storageKey}:${id}`) ?? 'null')
            if (typeof saved?.text === 'string') restored[id] = saved
          } catch {}
        }
        try {
          const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
          if (typeof saved?.text === 'string') {
            const target =
              saved.chatId && ids.includes(saved.chatId) ? saved.chatId : isDraft(selected) ? selected : null
            if (target && !restored[target])
              restored[target] = { text: saved.text, tools: saved.tools, selection: saved.selection, request: saved.chatId === target ? saved.request : undefined }
          }
        } catch {}
        setDrafts(restored)
        setTabs(ids)
        activate(selected)
        setReady(true)
      })
      .catch((e) => {
        if (current) setError(e.message)
      })
    return () => {
      current = false
      alive.current = false
      lifetime.current.abort()
    }
  }, [client, source.kind, source.id, panelKey])
  useEffect(() => {
    if (!ready) return
    try {
      localStorage.setItem(
        panelKey,
        JSON.stringify({ tabs: tabs.filter((id) => !isDraft(id)), active: isDraft(active) ? null : active })
      )
    } catch {}
  }, [ready, tabs, active, panelKey])
  useEffect(() => {
    if (!ready) return
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...draft, chatId: isDraft(active) ? null : active }))
      for (const [id, value] of Object.entries(drafts))
        if (!isDraft(id)) localStorage.setItem(`${storageKey}:${id}`, JSON.stringify(value))
    } catch {}
  }, [ready, drafts, active, storageKey])
  useEffect(() => {
    if (!ready || isDraft(active)) return
    void refresh(active)
    const reconnect = () => { if (exhausted.current.delete(active)) { setError(''); void refresh(active) } }
    window.addEventListener('online', reconnect)
    const timer = setInterval(() => void refresh(active), answering ? 800 : 10000)
    const end = answering ? client.events?.(active, () => void refresh(active)) : undefined
    return () => {
      clearInterval(timer)
      end?.()
      window.removeEventListener('online', reconnect)
    }
  }, [ready, active, answering, client])
  // The server names a chat after its first answer, a moment after the answer
  // ends; look again soon rather than at the next idle poll.
  const answered = useRef(answering)
  useEffect(() => {
    const was = answered.current
    answered.current = answering
    if (!was || answering || isDraft(active)) return
    const timers = [2000, 6000].map((ms) => setTimeout(() => void refresh(active), ms))
    return () => timers.forEach(clearTimeout)
  }, [answering, active])
  // Background replies keep running and keep their tab's activity dot accurate.
  const background = chats
    .filter((c) => c.running && c.id !== active)
    .map((c) => c.id)
    .join(',')
  useEffect(() => {
    if (!ready || !background) return
    const tick = () => {
      for (const id of background.split(',')) void refresh(id)
    }
    const timer = setInterval(tick, 1500)
    return () => clearInterval(timer)
  }, [ready, background])

  function open(id: string) {
    if (exhausted.current.delete(id) && !isDraft(id)) void refresh(id)
    setTabs((ids) => (ids.includes(id) ? ids : [...ids, id]))
    activate(id)
  }
  function startNew() {
    open(newDraft())
  }
  async function refreshHistory() {
    try {
      const result = await client.request<{ chats: LearningChat[] }>(
        `/learning/chats?kind=${source.kind}&id=${source.id}`
      )
      if (alive.current) setChats(result.chats.filter((c) => c.messages !== 0 && !removed.current.has(c.id)))
    } catch (e) {
      if (alive.current) setError((e as Error).message)
    }
  }
  function close(id: string) {
    const remaining = tabsRef.current.filter((t) => t !== id)
    if (!remaining.length) remaining.push(newDraft())
    setTabs(remaining)
    if (activeRef.current === id) activate(remaining[remaining.length - 1])
    if (isDraft(id))
      setDrafts((d) => {
        const next = { ...d }
        delete next[id]
        return next
      })
  }
  async function remove(id: string) {
    try {
      await client.request(`/learning/chats/${id}`, 'DELETE')
      if (!alive.current) return
      removed.current.add(id)
      setChats((list) => list.filter((c) => c.id !== id))
      setViews((v) => {
        const next = { ...v }
        delete next[id]
        return next
      })
      setDrafts((d) => {
        const next = { ...d }
        delete next[id]
        return next
      })
      try {
        localStorage.removeItem(`${storageKey}:${id}`)
      } catch {}
      if (tabsRef.current.includes(id)) close(id)
    } catch (e) {
      if (alive.current) setError((e as Error).message)
    }
  }
  function setText(text: string) {
    setDrafts((d) => ({ ...d, [active]: { ...d[active], text } }))
  }
  function setSelection(selection: ServerAIDefaults) {
    setDrafts(d => ({ ...d, [active]: { ...d[active], text: d[active]?.text ?? '', selection } }))
  }
  async function send(quote?: string, submittedText = draft.text, selection = draft.selection): Promise<boolean> {
    if (!ready || !submittedText.trim() || sendingRef.current || answering || (!isDraft(active) && !view)) return false
    let id = active
    const text = submittedText
    const request = draft.request?.text === text && draft.request.quote === quote && JSON.stringify(draft.request.selection) === JSON.stringify(selection)
      ? draft.request : { id: crypto.randomUUID(), text, quote, selection }
    sendingRef.current = id
    setSending(id)
    setError('')
    try {
      if (isDraft(id)) {
        const create = () => client.request<LearningChatView>('/learning/chats', 'POST', {
          ...source, ...(idempotentCreation ? { requestId: id.slice('draft:'.length) } : {}),
          ...(defaultSearch !== undefined ? { tools: draft.tools ?? { webSearch: defaultSearch } } : {})
        })
        const next = await (idempotentCreation ? recover('send', id, create) : create())
        if (!alive.current) return false
        const previous = id
        id = next.chat.id
        accept(next)
        setTabs((ids) => ids.map((t) => (t === previous ? id : t)))
        setDrafts((d) => {
          const next = { ...d, [id]: { text, request, selection } }
          delete next[previous]
          return next
        })
        if (activeRef.current === previous) activate(id)
        sendingRef.current = id
        setSending(id)
      } else setDrafts((d) => ({ ...d, [id]: { text, request, selection } }))
      // Save the target and deduplication ID before the network request, so a
      // dropped acknowledgment can only retry against this conversation.
      try {
        localStorage.setItem(`${storageKey}:${id}`, JSON.stringify({ text, request, selection }))
        localStorage.setItem(storageKey, JSON.stringify({ text, request, selection, chatId: id }))
      } catch {}
      await recover('send', id, () => client.request(`/learning/chats/${id}/messages`, 'POST', { text: request.text, requestId: request.id, ...(request.quote ? { quote: request.quote } : {}), ...request.selection }))
      if (!alive.current) return false
      setDrafts((d) => ({ ...d, [id]: { text: '', selection } }))
      exhausted.current.delete(id)
      await fetching.current.get(id)
      await refresh(id)
      return true
    } catch (e) {
      if (alive.current && activeRef.current === id) setError((e as Error).message)
      return false
    } finally {
      sendingRef.current = null
      if (alive.current) setSending(null)
    }
  }
  return {
    tabs,
    active,
    chats,
    view,
    retryAttempt: retries['send:' + active] ?? retries['read:' + active] ?? (!exhausted.current.has(active) && !view?.offline ? view?.messages.find(m => m.status === 'running')?.retryAttempt : undefined),
    tools: isDraft(active) ? draft.tools : view?.chat.tools,
    setTools: defaultSearch === undefined ? undefined : setTools,
    text: draft.text,
    setText,
    selection: draft.selection,
    setSelection,
    error,
    setError,
    ready,
    loading: !ready || (!isDraft(active) && !view),
    busy,
    answering,
    sending: sending !== null,
    open,
    startNew,
    refreshHistory,
    close,
    remove,
    send
  }
}
