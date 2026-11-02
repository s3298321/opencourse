import { nonnegativeInteger } from '@core/reading/tools'
import { useCoachContextBridge, useCoachContextProvider, selectedContent, contextExcerpt } from '../coach/context'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { WritingNotebook, WritingNotebookPage } from '@core/writing-notebooks/types'
import { MAX_QUOTE_CHARS } from '@core/sidechat/thread'
import type { ChatQuote, ReadingSource } from '@core/types'
import { MarkdownProvider } from '../markdown-context'
import ChatPanel from '../components/ChatPanel'
import ChatToggle from '../components/ChatToggle'
import Menu from '../components/Menu'
import ActionButton from '../components/ActionButton'
import ConfirmDialog, { type ConfirmRequest } from '../components/ConfirmDialog'
import ReadingSize from '../../learning-ui/ReadingSize'
import { useConversationPanel, type ChatTransport } from '../sidechat/useChat'
import { usePreviewAsk, PreviewAskOffer } from '../sidechat/usePreviewAsk'
import type { AskOffer } from '../ask-context'
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor'
import { darkChromeCss } from '@core/theme/dark-chrome'
import { TitleBarChrome } from '../components/TitleBar'
import { useActiveTheme } from '../theme/ThemeProvider'
const api = () => window.opencourse.writing
function NotebookContent({ id }: { id: string }) {
  const theme = useActiveTheme()
  const [notebook, setNotebook] = useState<WritingNotebook | null>(null), [page, setPage] = useState<WritingNotebookPage | null>(null)
  const [error, setError] = useState(''), [status, setStatus] = useState('Saved'), [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0)
  const [offer, setOffer] = useState<AskOffer | null>(null), [quote, setQuote] = useState<ChatQuote | null>(null)
  const [confirmation, setConfirmation] = useState<{ request: ConfirmRequest; resolve: (yes: boolean) => void } | null>(null)
  const [conflict, setConflict] = useState<WritingNotebookPage | null>(null)
  const editor = useRef<MarkdownEditorHandle>(null), current = useRef<WritingNotebookPage | null>(null), saved = useRef(''), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTitle = useRef(''), titleBeforeEdit = useRef('')
  useCoachContextBridge()
  useCoachContextProvider(request => {
    const value = current.current
    if (!notebook || !value) return null
    const unsaved = value.markdown !== saved.current || value.title !== savedTitle.current
    if (request.tool === 'get_app_context') return { kind: 'writing-notebook', visible: true, notebookId: id, title: notebook.title, pageId: value.id, pageTitle: value.title, unsaved,
      ...selectedContent(document.querySelector('.writing-editor')), ...contextExcerpt(value.markdown) }
    if (request.tool === 'read_notebook_page' && request.args.notebook_id === id && request.args.page_id === value.id) {
      const offset = nonnegativeInteger(request.args.offset), text = value.markdown.slice(offset, offset + 6500)
      return { value: { source: `${notebook.title} · ${value.title}`, text, state: 'open editor', unsaved, revision: value.revision, nextOffset: offset + text.length < value.markdown.length ? offset + text.length : null } }
    }
    return null
  })
  const saving = useRef<Promise<void> | null>(null), conflictRef = useRef(false)
  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    await editor.current?.waitForImages()
    if (saving.current) { await saving.current; return flush() }
    if (conflictRef.current) throw new Error('Resolve the conflicting page before continuing.')
    const task = (async () => {
      while (current.current && (current.current.markdown !== saved.current || (current.current.title.trim() || 'Untitled page') !== savedTitle.current)) {
        const snapshot = { ...current.current }; setStatus('Saving…')
        const title = snapshot.title.trim() || 'Untitled page'
        if (title !== savedTitle.current) {
          await api().renamePage(id, snapshot.id, title)
          savedTitle.current = title
          setNotebook(notebook => notebook ? { ...notebook, pages: notebook.pages.map(page => page.id === snapshot.id ? { ...page, title: current.current?.id === snapshot.id ? current.current.title.trim() || 'Untitled page' : title } : page) } : notebook)
        }
        if (snapshot.markdown === saved.current) continue
        const result = await api().save(id, snapshot.id, snapshot.revision, snapshot.markdown)
        if (!result.ok) { conflictRef.current = true; setConflict(result.page); throw new Error('This page changed elsewhere. Choose which version to keep.') }
        if (current.current?.id === snapshot.id) { current.current.revision = result.page.revision; saved.current = snapshot.markdown }
      }
      setStatus('Saved'); setError('')
    })()
    saving.current = task
    try { await task } catch (error) { setStatus('Not saved'); setError((error as Error).message); throw error } finally { saving.current = null }
  }, [id])
  const load = useCallback(async (next: WritingNotebook, pageId = next.selectedPageId) => {
    const value = await api().page(id, pageId)
    current.current = value; saved.current = value.markdown; savedTitle.current = value.title; conflictRef.current = false; setConflict(null); setPage(value); setNotebook(next)
    setOffer(null); setQuote(value => value?.from === 'answer' ? value : null); setStatus('Saved'); setError('')
  }, [id])
  useEffect(() => { void api().get(id).then(value => load(value)).catch(e => setError(e.message)); return () => { if (timer.current) clearTimeout(timer.current) } }, [id, load])
  const change = useCallback((markdown: string) => { if (!current.current) return; current.current.markdown = markdown; setStatus('Saving…'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}) }, 500) }, [flush])
  const changeTitle = (title: string) => {
    const value = current.current
    if (!value) return
    value.title = title
    setPage(page => page?.id === value.id ? { ...page, title } : page)
    setNotebook(notebook => notebook ? { ...notebook, pages: notebook.pages.map(page => page.id === value.id ? { ...page, title: title.trim() || 'Untitled page' } : page) } : notebook)
    setStatus('Saving…')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush().catch(() => {}) }, 500)
  }
  const selectPage = useCallback(async (pageId: string) => {
    setBusy(true)
    try { await flush(); const next = await api().update(id, { selectedPageId: pageId }); await load(next) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [flush, id, load])
  useEffect(() => api().onSelectPage(pageId => { void selectPage(pageId) }), [selectPage])
  useEffect(() => api().onFlush(request => { setBusy(true); void flush().then(() => api().flushed(request, true), () => { setBusy(false); api().flushed(request, false) }) }), [flush])
  useEffect(() => api().onSave(() => { void flush().catch(() => {}) }), [flush])
  useEffect(() => api().onResume(() => setBusy(false)), [])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (current.current?.markdown !== saved.current || (current.current && (current.current.title.trim() || 'Untitled page') !== savedTitle.current) || saving.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload)
  }, [])
  useEffect(() => { if (notebook && page) api().ready() }, [notebook?.id, page?.id])
  const transport = useMemo<ChatTransport>(() => {
    const chat = api().chat
    return { ...chat, list: () => chat.list(id), create: () => chat.create(id, current.current!.id),
      send: async (chatId, text, quoted) => { const pageId = current.current!.id; await flush(); return chat.send(chatId, text, quoted, pageId) } }
  }, [id, flush])
  const storageKey = `writing:${id}`
  const panel = useConversationPanel(transport, 'chat', notebook?.chatOpen ?? false, storageKey)
  const answerAsk = usePreviewAsk(true, page?.id ?? '', false)
  useEffect(() => { if (!quote) answerAsk.clearQuote() }, [quote, answerAsk.clearQuote])
  const update = useCallback(async (patch: Parameters<ReturnType<typeof api>['update']>[1]) => { const next = await api().update(id, patch); setNotebook(next) }, [id])
  const toggleChat = () => { void update({ chatOpen: !notebook?.chatOpen }).catch(e => setError(e.message)) }
  const attach = (selection: AskOffer) => {
    if (!current.current) return
    if (selection.from === 'answer') answerAsk.ask.attach(selection); else editor.current?.clearSelection()
    setQuote({ text: selection.text.slice(0, MAX_QUOTE_CHARS), from: selection.from === 'answer' ? 'answer' : 'writing-notebook', ...(selection.from !== 'answer' ? { writingNotebook: { notebookId: id, pageId: current.current.id, revision: current.current.revision, title: current.current.title } } : {}) })
    setOffer(null); void update({ chatOpen: true }).catch(e => setError(e.message))
  }
  const confirm = (title: string, detail: string): Promise<boolean> => new Promise(resolve => setConfirmation({ request: { title, detail, confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true }, resolve }))
  const action = (operation: () => Promise<void>) => { if (busy) return; setBusy(true); void flush().then(operation).catch(e => setError(e.message)).finally(() => setBusy(false)) }
  const deletePage = (pageId: string, title: string) => {
    void confirm('Delete this page?', `“${title}” will be deleted. Existing conversations will be kept.`).then(yes => {
      if (yes) action(async () => {
        const next = await api().deletePage(id, pageId)
        if (current.current?.id === pageId) await load(next)
        else setNotebook(next)
      })
    })
  }
  const source = (ref: ReadingSource) => { if (ref.kind === 'writing-notebook' && ref.notebookId === id) void selectPage(ref.pageId); else void api().source(ref).catch(e => setError(e.message)) }
  const resetConflict = (keep: boolean) => {
    if (!conflict || !current.current) return
    current.current.revision = conflict.revision; saved.current = conflict.markdown; conflictRef.current = false; setConflict(null)
    if (!keep) { savedTitle.current = conflict.title; current.current = conflict; setPage(conflict); setEpoch(value => value + 1); setStatus('Saved'); setError('') }
    else void flush().catch(() => {})
  }
  if (!notebook || !page) return <div className="empty">{error || 'Opening notebook…'}</div>
  const index = notebook.pages.findIndex(p => p.id === page.id)
  const reorder = (direction: number) => action(async () => { const ids = notebook.pages.map(p => p.id); [ids[index], ids[index + direction]] = [ids[index + direction]!, ids[index]!]; setNotebook(await api().reorder(id, ids)) })
  return <div className="app writing-window" data-default-theme={theme.id === null ? '' : undefined} style={{ '--reading-scale': notebook.textScale } as CSSProperties}>
    <style>{darkChromeCss}</style>
    <TitleBarChrome title={notebook.title} showPomodoro actions={<ChatToggle open={notebook.chatOpen} onClick={toggleChat} subject="notebook" />} />
    <div className="body lesson-body writing-body">
      <aside className="sidebar writing-sidebar">
        {notebook.association && <p className="writing-association">{notebook.association.title}{notebook.associationAvailable === false && <span> · Source unavailable</span>}</p>}
        <nav aria-label="Notebook pages">{notebook.pages.map(p => <Menu key={p.id} label={<span>{p.title}</span>} triggerMode="contextmenu" className={`sidebar-notebook-link writing-page-link${p.id === page.id ? ' current' : ''}`} aria-current={p.id === page.id ? 'page' : undefined} disabled={busy} onClick={() => void selectPage(p.id)} resetKey={page.id} items={[
          { id: 'delete', label: 'Delete page', danger: true, disabled: notebook.pages.length === 1, hint: notebook.pages.length === 1 ? 'Keep at least one page' : undefined, onSelect: () => deletePage(p.id, p.title) }
        ]} />)}</nav>
        <button className="writing-new-page action-button secondary" disabled={busy} onClick={() => action(async () => { await load(await api().addPage(id)) })}>＋ New page</button>
        <ActionButton icon="trash" className="writing-delete-notebook ghost" disabled={busy} onClick={() => { void confirm('Delete this notebook?', 'Its pages, images, and conversations will be deleted.').then(yes => { if (yes) action(async () => { await api().remove(id) }) }) }}>Delete notebook</ActionButton>
      </aside>
      <main className="writing-page" data-layout={notebook.textLayout ?? 'wide'} inert={busy}>
        <div className="writing-page-heading"><h1><input className="writing-page-title" type="text" aria-label="Page title" placeholder="Untitled page" value={page.title} maxLength={200}
          onFocus={() => { titleBeforeEdit.current = current.current?.title ?? page.title }}
          onChange={event => changeTitle(event.target.value)}
          onBlur={() => { changeTitle(current.current?.title.trim() || 'Untitled page'); void flush().catch(() => {}) }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); changeTitle(titleBeforeEdit.current); event.currentTarget.blur() }
          }}
        /></h1><span className="meta" role="status">{status}</span><Menu label="•••" ariaLabel="Notebook options" heading="Notebook options" panelClassName="writing-options-menu" items={[
          { id: 'line-numbers', label: 'Line numbers', checked: notebook.showLineNumbers ?? false, checkType: 'checkbox', hint: notebook.showLineNumbers ? 'On' : 'Off', onSelect: () => { void update({ showLineNumbers: !notebook.showLineNumbers }).catch(e => setError(e.message)) } },
          { id: 'wide', label: 'Wide text', checked: notebook.textLayout !== 'thin', onSelect: () => { void update({ textLayout: 'wide' }).catch(e => setError(e.message)) } },
          { id: 'thin', label: 'Thin text', checked: notebook.textLayout === 'thin', onSelect: () => { void update({ textLayout: 'thin' }).catch(e => setError(e.message)) } },
          ...(index > 0 ? [{ id: 'up', label: 'Move up', onSelect: () => reorder(-1) }] : []),
          ...(index < notebook.pages.length - 1 ? [{ id: 'down', label: 'Move down', onSelect: () => reorder(1) }] : []),
          ...(notebook.pages.length > 1 ? [{ id: 'delete', label: 'Delete page', danger: true, onSelect: () => deletePage(page.id, page.title) }] : [])
        ]} /></div>
        {error && <div className="writing-error" role="alert"><span>{error}</span>{!conflict && <button onClick={() => void flush().catch(() => {})}>Retry save</button>}</div>}
        {conflict && <div className="writing-error"><button onClick={() => resetConflict(true)}>Keep my edits</button><button onClick={() => resetConflict(false)}>Reload saved page</button></div>}
        <MarkdownEditor key={`${page.id}:${epoch}`} ref={editor} notebookId={id} initial={page.markdown} showLineNumbers={notebook.showLineNumbers} textLayout={notebook.textLayout} onChange={change} onOffer={setOffer} onError={setError} onSave={() => void flush().catch(() => {})} />
        <ReadingSize scale={notebook.textScale} onChange={textScale => { void update({ textScale }).catch(e => setError(e.message)) }} />
      </main>
      <div className="lesson-chat-host" data-open={notebook.chatOpen} inert={!notebook.chatOpen} aria-hidden={!notebook.chatOpen}><ChatPanel visible={notebook.chatOpen} variant="notebook" panel={panel} quote={quote} onQuoteUsed={() => setQuote(null)} onClose={toggleChat} onAddKey={() => { void api().settings() }} textScale={notebook.textScale} storageKey={storageKey} sourceIcons={api().chat.icons} onSource={source} /></div>
    </div>
    <PreviewAskOffer offer={offer ?? (answerAsk.selection?.from === 'answer' ? answerAsk.selection : null)} attach={attach} />
    {confirmation && <ConfirmDialog request={confirmation.request} onResult={yes => { confirmation.resolve(yes); setConfirmation(null) }} />}
  </div>
}
export default function NotebookWindow({ id }: { id: string }) { return <MarkdownProvider><NotebookContent id={id} /></MarkdownProvider> }
