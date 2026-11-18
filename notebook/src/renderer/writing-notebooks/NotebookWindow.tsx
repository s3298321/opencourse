import { nonnegativeInteger } from '@core/reading/tools'
import { useCoachContextBridge, useCoachContextProvider, selectedContent, contextExcerpt } from '../coach/context'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { WritingNotebook, WritingNotebookPage } from '@core/writing-notebooks/types'
import { MAX_QUOTE_CHARS } from '@core/sidechat/thread'
import type { ChatQuote, ReadingSource, UserProfile } from '@core/types'
import type { Route } from '../routes'
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
import FileView, { type OpenFileView } from './FileView'
import TitleDialog from './TitleDialog'
import PageTree, { type PageTreeActions } from './PageTree'
import { findFileNode, findPageNode, pageFileName, pagesUnder, pageTitle, renamePageNode, treeJoin, treeName, treeParent } from '@core/writing-notebooks/tree'
import { mediaKind } from '@core/writing-notebooks/files'
import { TitleBarChrome } from '../components/TitleBar'
import { useActiveTheme } from '../theme/ThemeProvider'
const api = () => window.opencourse.writing
function NotebookContent({ id, user, navigate, route, onOpen, onDeleted, focusPageId, focusToken }: {
  id: string
  user?: UserProfile | null
  navigate?: (next: Route) => void
  route?: Route
  onOpen?: (id: string) => void
  onDeleted?: () => void
  focusPageId?: string
  focusToken?: number
}) {
  const theme = useActiveTheme()
  const [notebook, setNotebook] = useState<WritingNotebook | null>(null), [page, setPage] = useState<WritingNotebookPage | null>(null)
  const [error, setError] = useState(''), [status, setStatus] = useState('Saved'), [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0)
  const [offer, setOffer] = useState<AskOffer | null>(null), [quote, setQuote] = useState<ChatQuote | null>(null)
  const [confirmation, setConfirmation] = useState<{ request: ConfirmRequest; resolve: (yes: boolean) => void } | null>(null)
  const [library, setLibrary] = useState<WritingNotebook[]>([])
  const [creating, setCreating] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState(''), [draftFolder, setDraftFolder] = useState<{ parent: string } | null>(null), [draftFile, setDraftFile] = useState<{ parent: string } | null>(null)
  const [conflict, setConflict] = useState<WritingNotebookPage | null>(null)
  const [fileView, setFileView] = useState<OpenFileView | null>(null)
  const editor = useRef<MarkdownEditorHandle>(null), current = useRef<WritingNotebookPage | null>(null), saved = useRef(''), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A text file open in the pane has the same draft shape as a page: edits debounce into flush().
  const fileDraft = useRef<{ path: string; text: string; saved: string } | null>(null), fileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileViewRef = useRef<OpenFileView | null>(null); fileViewRef.current = fileView
  // The page's title is its file name; the heading edits it, and saving renames the file.
  const [title, setTitle] = useState(''), titleRef = useRef(''), savedTitle = useRef(''), titleBeforeEdit = useRef('')
  const titleOf = (nb: WritingNotebook | null, pageId: string): string => {
    const node = nb ? findPageNode(nb.tree ?? [], pageId) : undefined
    return node ? pageTitle(node.path) : ''
  }
  useCoachContextBridge()
  useCoachContextProvider(request => {
    const value = current.current
    if (!notebook || !value) return null
    const unsaved = value.markdown !== saved.current || titleRef.current !== savedTitle.current
    if (request.tool === 'get_app_context') return { kind: 'writing-notebook', visible: true, notebookId: id, title: notebook.title, pageId: value.id, pageTitle: titleRef.current, unsaved,
      ...selectedContent(document.querySelector('.writing-editor')), ...contextExcerpt(value.markdown) }
    if (request.tool === 'read_notebook_page' && request.args.notebook_id === id && request.args.page_id === value.id) {
      const offset = nonnegativeInteger(request.args.offset), text = value.markdown.slice(offset, offset + 6500)
      return { value: { source: `${notebook.title} · ${titleRef.current}`, text, state: 'open editor', unsaved, revision: value.revision, nextOffset: offset + text.length < value.markdown.length ? offset + text.length : null } }
    }
    return null
  })
  const saving = useRef<Promise<void> | null>(null), conflictRef = useRef(false)
  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    if (fileTimer.current) clearTimeout(fileTimer.current)
    // A text file open in the pane saves through the same flush as the page.
    const draft = fileDraft.current
    if (draft && draft.text !== draft.saved) {
      setStatus('Saving…')
      await api().saveFile(id, draft.path, draft.text)
      draft.saved = draft.text
    }
    await editor.current?.waitForImages()
    if (saving.current) { await saving.current; return flush() }
    if (conflictRef.current) throw new Error('Resolve the conflicting page before continuing.')
    const task = (async () => {
      while (current.current && (current.current.markdown !== saved.current || (titleRef.current.trim() || 'Untitled page') !== savedTitle.current)) {
        const snapshot = { ...current.current }; setStatus('Saving…')
        const wanted = titleRef.current.trim() || 'Untitled page'
        if (wanted !== savedTitle.current) {
          // Renaming the page renames its file; the returned notebook carries the actual (possibly suffixed) file name.
          const next = await api().renamePage(id, snapshot.id, wanted)
          const actual = titleOf(next, snapshot.id) || wanted
          savedTitle.current = actual
          if (current.current?.id === snapshot.id) { titleRef.current = actual; setTitle(actual) }
          setNotebook(next)
        }
        if (snapshot.markdown === saved.current) continue
        await editor.current?.flushSketches(snapshot.markdown)
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
    const loaded = titleOf(next, pageId) || 'Untitled page'
    current.current = value; saved.current = value.markdown; savedTitle.current = loaded; titleRef.current = loaded; setTitle(loaded)
    conflictRef.current = false; setConflict(null); setPage(value); setNotebook(next)
    setOffer(null); setQuote(value => value?.from === 'answer' ? value : null); setStatus('Saved'); setError('')
  }, [id])
  useEffect(() => { void api().get(id).then(value => load(value)).catch(e => setError(e.message)); return () => { if (timer.current) clearTimeout(timer.current); if (fileTimer.current) clearTimeout(fileTimer.current); void flush() } }, [id, load, flush])
  useEffect(() => { void api().list().then(setLibrary).catch(() => {}); return api().onChanged(() => { void api().list().then(setLibrary).catch(() => {}) }) }, [])
  // Finder edits and other windows reach this one through the same changed event.
  useEffect(() => api().onChanged(changedId => {
    if (changedId !== id) return
    void api().get(id).then(next => {
      setNotebook(next)
      if (current.current && !next.pages.some(p => p.id === current.current!.id)) void load(next)
      const view = fileViewRef.current
      if (!view) return
      // The open file was deleted or moved elsewhere: close its pane, draft included.
      if (!findFileNode(next.tree ?? [], view.path)) { fileDraft.current = null; setFileView(null); return }
      // An external edit to the open text file lands here while the draft is clean.
      if (view.view.kind === 'text' && fileDraft.current?.path === view.path && fileDraft.current.text === fileDraft.current.saved) {
        void api().readFile(id, view.path).then(content => {
          const now = fileViewRef.current
          if (content.kind !== 'text' || !now || now.path !== view.path) return
          if (fileDraft.current?.path === view.path && fileDraft.current.text !== fileDraft.current.saved) return
          fileDraft.current = { path: view.path, text: content.text, saved: content.text }
          setFileView({ ...now, view: content })
          setEpoch(value => value + 1)
        }).catch(() => {})
      }
    }).catch(() => {})
  }), [id, load])
  const change = useCallback((markdown: string) => { if (!current.current) return; current.current.markdown = markdown; setStatus('Saving…'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}) }, 500) }, [flush])
  const changeTitle = (value: string) => {
    const page = current.current
    if (!page) return
    const clean = value.trim() || 'Untitled page'
    setTitle(value); titleRef.current = value
    // Optimistic: the page's file name (and so its row label) follows the typed title until the rename lands.
    setNotebook(notebook => notebook ? { ...notebook, pages: notebook.pages.map(p => p.id === page.id ? { ...p, path: treeJoin(treeParent(p.path), pageFileName(clean)) } : p), tree: renamePageNode(notebook.tree ?? [], page.id, clean) } : notebook)
    setStatus('Saving…')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush().catch(() => {}) }, 500)
  }
  const selectPage = useCallback(async (pageId: string) => {
    setBusy(true)
    try { await flush(); fileDraft.current = null; setFileView(null); const next = await api().update(id, { selectedPageId: pageId }); await load(next) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [flush, id, load])
  const focus = useRef({ pageId: focusPageId, selectPage })
  focus.current = { pageId: focusPageId, selectPage }
  useEffect(() => { const pageId = focus.current.pageId; if (pageId) void focus.current.selectPage(pageId) }, [focusToken])
  useEffect(() => api().onSelectPage(pageId => { void selectPage(pageId) }), [selectPage])
  useEffect(() => api().onFlush(request => { setBusy(true); void flush().then(() => api().flushed(request, true), () => { setBusy(false); api().flushed(request, false) }) }), [flush])
  useEffect(() => api().onSave(() => { void flush().catch(() => {}) }), [flush])
  useEffect(() => api().onResume(() => setBusy(false)), [])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (current.current?.markdown !== saved.current || (current.current && (titleRef.current.trim() || 'Untitled page') !== savedTitle.current) || (fileDraft.current && fileDraft.current.text !== fileDraft.current.saved) || saving.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload)
  }, [])
  useEffect(() => { if (notebook && page) api().ready(id) }, [notebook?.id, page?.id, id])
  useEffect(() => () => { api().idle() }, [])
  const transport = useMemo<ChatTransport>(() => {
    const chat = api().chat
    return { ...chat, list: () => chat.list(id), create: () => chat.create(id, current.current!.id),
      send: async (chatId, text, quoted) => { const pageId = current.current!.id; await flush(); return chat.send(chatId, text, quoted, pageId) } }
  }, [id, flush])
  const storageKey = `writing:${id}`
  const panel = useConversationPanel(transport, 'chat', notebook?.chatOpen ?? false, storageKey, 'writing-notebook')
  const answerAsk = usePreviewAsk(true, page?.id ?? '', false)
  useEffect(() => { if (!quote) answerAsk.clearQuote() }, [quote, answerAsk.clearQuote])
  const update = useCallback(async (patch: Parameters<ReturnType<typeof api>['update']>[1]) => { const next = await api().update(id, patch); setNotebook(next) }, [id])
  const toggleChat = () => { void update({ chatOpen: !notebook?.chatOpen }).catch(e => setError(e.message)) }
  const attach = (selection: AskOffer) => {
    if (!current.current) return
    if (selection.from === 'answer') answerAsk.ask.attach(selection); else editor.current?.clearSelection()
    setQuote({ text: selection.text.slice(0, MAX_QUOTE_CHARS), from: selection.from === 'answer' ? 'answer' : 'writing-notebook', ...(selection.from !== 'answer' ? { writingNotebook: { notebookId: id, pageId: current.current.id, revision: current.current.revision, title: titleRef.current } } : {}) })
    setOffer(null); void update({ chatOpen: true }).catch(e => setError(e.message))
  }
  const confirm = (title: string, detail: string): Promise<boolean> => new Promise(resolve => setConfirmation({ request: { title, detail, confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true }, resolve }))
  const action = (operation: () => Promise<void>) => { if (busy) return; setBusy(true); void flush().then(operation).catch(e => setError(e.message)).finally(() => setBusy(false)) }
  // A file opens in the main pane: media straight from its URL, anything else read as text first.
  const showFile = async (path: string) => {
    const name = treeName(path), media = mediaKind(name)
    if (media) { setFileView({ path, name, view: { kind: media } }); return }
    const content = await api().readFile(id, path)
    if (content.kind === 'text') fileDraft.current = { path, text: content.text, saved: content.text }
    setFileView({ path, name, view: content })
  }
  const openFile = (path: string) => action(() => showFile(path))
  const changeFile = (text: string) => {
    const draft = fileDraft.current
    if (!draft) return
    draft.text = text
    setStatus('Saving…')
    if (fileTimer.current) clearTimeout(fileTimer.current)
    fileTimer.current = setTimeout(() => { void flush().catch(() => {}) }, 500)
  }
  const deletePage = (pageId: string, title: string) => {
    void confirm('Delete this page?', `“${title}” will be deleted. Existing conversations will be kept.`).then(yes => {
      if (yes) action(async () => {
        const next = await api().deletePage(id, pageId)
        if (current.current?.id === pageId) await load(next)
        else setNotebook(next)
      })
    })
  }
  const commitFolder = (name: string) => {
    const parent = draftFolder?.parent ?? ''
    setDraftFolder(null); setDraftFile(null)
    action(async () => { setNotebook(await api().createFolder(id, parent, name)) })
  }
  // A new file is created empty at the draft's folder, then opened in the pane.
  const commitFile = (name: string) => {
    const parent = draftFile?.parent ?? ''
    setDraftFile(null)
    action(async () => {
      setNotebook(await api().createFile(id, parent, name))
      await showFile(treeJoin(parent, name))
    })
  }
  const treeActions: PageTreeActions = {
    openPage: pageId => { void selectPage(pageId) },
    openFile,
    selectFolder: setSelectedFolder,
    newPage: folder => action(async () => { await load(await api().addPage(id, undefined, folder)) }),
    newFolder: parent => { setSelectedFolder(parent); setDraftFile(null); setDraftFolder({ parent }) },
    newFile: folder => { setSelectedFolder(folder); setDraftFolder(null); setDraftFile({ parent: folder }) },
    deletePage,
    deleteFolder: (path, name, pageCount) => {
      const pages = pageCount ? ` with ${pageCount} page${pageCount === 1 ? '' : 's'} inside it` : ''
      void confirm('Delete this folder?', `“${name}” will be deleted${pages}. Any other files inside it will be deleted too. Existing conversations will be kept.`).then(yes => {
        if (yes) action(async () => {
          const next = await api().deleteFolder(id, path)
          if (current.current && !next.pages.some(p => p.id === current.current!.id)) await load(next)
          else setNotebook(next)
        })
      })
    },
    deleteFile: (path, name) => {
      void confirm('Delete this file?', `“${name}” will be deleted from the notebook.`).then(yes => {
        if (yes) action(async () => {
          setNotebook(await api().deleteFile(id, path))
          if (fileView?.path === path) { fileDraft.current = null; setFileView(null) }
        })
      })
    },
    reveal: path => { void api().reveal(id, path).catch(e => setError(e.message)) },
    move: (source, targetFolder) => action(async () => {
      setNotebook(await api().move(id, source, targetFolder))
      // The open file's pane follows it to its new path.
      if (fileView && source === fileView.path) {
        const moved = treeJoin(targetFolder, treeName(source))
        if (fileDraft.current?.path === source) fileDraft.current.path = moved
        setFileView({ ...fileView, path: moved })
      }
    }),
    importFiles: (folder, files) => action(async () => { setNotebook(await api().importFiles(id, folder, files)) }),
    rename: (path, name) => action(async () => {
      setNotebook(await api().rename(id, path, name))
      if (fileView?.path === path) {
        const moved = treeJoin(treeParent(path), name)
        if (fileDraft.current?.path === path) fileDraft.current.path = moved
        setFileView({ ...fileView, path: moved, name })
      }
    }),
    renamePage: (pageId, name) => action(async () => {
      const next = await api().renamePage(id, pageId, name)
      setNotebook(next)
      // Keep the open editor's title in sync so the next save does not resurrect the old one.
      if (current.current?.id === pageId) { const actual = titleOf(next, pageId) || name; savedTitle.current = actual; titleRef.current = actual; setTitle(actual) }
    }),
    dropPage: (pageId, targetFolder, anchor) => action(async () => {
      if (!notebook) return
      const node = findPageNode(notebook.tree ?? [], pageId)
      let next = notebook
      if (node && treeParent(node.path) !== targetFolder) next = await api().move(id, node.path, targetFolder)
      const ids = next.pages.map(p => p.id).filter(value => value !== pageId)
      if (anchor) { const at = ids.indexOf(anchor.pageId); ids.splice(at < 0 ? ids.length : at + (anchor.after ? 1 : 0), 0, pageId) }
      else {
        const last = pagesUnder(next.tree ?? [], targetFolder).filter(p => p.id !== pageId).at(-1)
        if (last) ids.splice(ids.indexOf(last.id) + 1, 0, pageId); else ids.push(pageId)
      }
      setNotebook(await api().reorder(id, ids))
    })
  }
  const source = (ref: ReadingSource) => { if (ref.kind === 'writing-notebook' && ref.notebookId === id) void selectPage(ref.pageId); else void api().source(ref).catch(e => setError(e.message)) }
  const resetConflict = (keep: boolean) => {
    if (!conflict || !current.current) return
    current.current.revision = conflict.revision; saved.current = conflict.markdown; conflictRef.current = false; setConflict(null)
    if (!keep) { current.current = conflict; setPage(conflict); setEpoch(value => value + 1); setStatus('Saved'); setError('') }
    else void flush().catch(() => {})
  }
  if (!notebook || !page) return <div className="empty">{error || 'Opening notebook…'}</div>
  // Move up/down stay inside the page's own folder.
  const folderOf = (pageId: string) => treeParent(findPageNode(notebook.tree ?? [], pageId)?.path ?? '')
  const siblings = notebook.pages.filter(p => folderOf(p.id) === folderOf(page.id))
  const index = siblings.findIndex(p => p.id === page.id)
  const reorder = (direction: number) => action(async () => {
    const ids = notebook.pages.map(p => p.id)
    const a = ids.indexOf(siblings[index]!.id), b = ids.indexOf(siblings[index + direction]!.id)
    ;[ids[a], ids[b]] = [ids[b]!, ids[a]!]
    setNotebook(await api().reorder(id, ids))
  })
  return <div className="app writing-window" data-default-theme={theme.id === null ? '' : undefined} style={{ '--reading-scale': notebook.textScale } as CSSProperties}>
    <TitleBarChrome title={notebook.title} showPomodoro user={user} navigate={navigate} route={route} actions={<ChatToggle open={notebook.chatOpen} onClick={toggleChat} subject="notebook" />} />
    <div className="body lesson-body writing-body">
      <aside className="sidebar writing-sidebar">
        <Menu className="writing-notebook-switch" panelClassName="writing-notebook-switch-menu" ariaLabel="Notebooks" label={<span className="writing-notebook-switch-title">{notebook.title}</span>} items={[
          ...library.map(item => ({ id: item.id, label: item.title, checked: item.id === notebook.id, checkType: 'radio' as const, onSelect: () => { if (item.id !== notebook.id) onOpen?.(item.id) } })),
          { id: 'new', label: 'New notebook', onSelect: () => setCreating(true) }
        ]} />
        <PageTree notebook={notebook} currentPageId={page.id} currentFilePath={fileView?.path ?? null} selectedFolder={selectedFolder} busy={busy}
          draftFolder={draftFolder} draftFile={draftFile} onDraftCommit={commitFolder} onFileDraftCommit={commitFile} onDraftCancel={() => setDraftFolder(null)} onFileDraftCancel={() => setDraftFile(null)} actions={treeActions} />
        <button className="writing-new-page action-button secondary" disabled={busy} onClick={() => treeActions.newPage(selectedFolder)}>＋ New page</button>
        <button className="writing-new-file action-button secondary" disabled={busy} onClick={() => treeActions.newFile(selectedFolder)}>＋ New file</button>
        <button className="writing-new-folder action-button secondary" disabled={busy} onClick={() => treeActions.newFolder(selectedFolder)}>＋ New folder</button>
        <ActionButton icon="trash" className="writing-delete-notebook ghost" disabled={busy} onClick={() => { void confirm('Delete this notebook?', 'Its pages, files, images, and conversations will be deleted.').then(yes => { if (yes) action(async () => { await api().remove(id); onDeleted?.() }) }) }}>Delete notebook</ActionButton>
      </aside>
      <main className="writing-page" data-layout={notebook.textLayout ?? 'wide'} inert={busy}>
        <div className="writing-page-heading">{fileView
          ? <h1 className="writing-file-title">{fileView.name}</h1>
          : <h1><input className="writing-page-title" type="text" aria-label="Page title" placeholder="Untitled page" value={title} maxLength={200}
          onFocus={() => { titleBeforeEdit.current = titleRef.current }}
          onChange={event => changeTitle(event.target.value)}
          onBlur={() => { changeTitle(titleRef.current.trim() || 'Untitled page'); void flush().catch(() => {}) }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); editor.current?.focusAtStart() }
            if (event.key === 'Escape') { event.preventDefault(); changeTitle(titleBeforeEdit.current); event.currentTarget.blur() }
          }}
        /></h1>}
        <span className="meta" role="status">{status}</span>
        {fileView
          ? <Menu label="•••" ariaLabel="File options" heading="File options" panelClassName="writing-options-menu" items={[
            { id: 'reveal', label: 'Reveal in Finder', onSelect: () => treeActions.reveal(fileView.path) },
            { id: 'delete', label: 'Delete file', danger: true, onSelect: () => treeActions.deleteFile(fileView.path, fileView.name) }
          ]} />
          : <Menu label="•••" ariaLabel="Notebook options" heading="Notebook options" panelClassName="writing-options-menu" items={[
            { id: 'line-numbers', label: 'Line numbers', checked: notebook.showLineNumbers ?? false, checkType: 'checkbox', hint: notebook.showLineNumbers ? 'On' : 'Off', onSelect: () => { void update({ showLineNumbers: !notebook.showLineNumbers }).catch(e => setError(e.message)) } },
            { id: 'wide', label: 'Wide text', checked: notebook.textLayout !== 'thin', checkType: 'checkbox', hint: notebook.textLayout !== 'thin' ? 'On' : 'Off', onSelect: () => { void update({ textLayout: notebook.textLayout !== 'thin' ? 'thin' : 'wide' }).catch(e => setError(e.message)) } },
            ...(index > 0 ? [{ id: 'up', label: 'Move up', onSelect: () => reorder(-1) }] : []),
            ...(index < siblings.length - 1 ? [{ id: 'down', label: 'Move down', onSelect: () => reorder(1) }] : []),
            ...(notebook.pages.length > 1 ? [{ id: 'delete', label: 'Delete page', danger: true, onSelect: () => deletePage(page.id, title) }] : [])
          ]} />}
      </div>
        {error && <div className="writing-error" role="alert"><span>{error}</span>{!conflict && <button onClick={() => void flush().catch(() => {})}>Retry save</button>}</div>}
        {conflict && <div className="writing-error"><button onClick={() => resetConflict(true)}>Keep my edits</button><button onClick={() => resetConflict(false)}>Reload saved page</button></div>}
        {fileView
          ? <FileView key={`${fileView.path}:${epoch}`} notebookId={id} file={fileView} textScale={notebook.textScale} onChange={changeFile} onSave={() => void flush().catch(() => {})} />
          : <MarkdownEditor key={`${page.id}:${epoch}`} ref={editor} notebookId={id} initial={page.markdown} showLineNumbers={notebook.showLineNumbers} textLayout={notebook.textLayout} onChange={change} onOffer={setOffer} onError={setError} onSave={() => void flush().catch(() => {})} />}
        <ReadingSize scale={notebook.textScale} onChange={textScale => { void update({ textScale }).catch(e => setError(e.message)) }} />
      </main>
      <div className="lesson-chat-host" data-open={notebook.chatOpen} inert={!notebook.chatOpen} aria-hidden={!notebook.chatOpen}><ChatPanel visible={notebook.chatOpen} variant="notebook" panel={panel} quote={quote} onQuoteUsed={() => setQuote(null)} onClose={toggleChat} onAddKey={() => { void api().settings() }} textScale={notebook.textScale} storageKey={storageKey} sourceIcons={api().chat.icons} onSource={source} /></div>
    </div>
    <PreviewAskOffer offer={offer ?? (answerAsk.selection?.from === 'answer' ? answerAsk.selection : null)} attach={attach} />
    {confirmation && <ConfirmDialog request={confirmation.request} onResult={yes => { confirmation.resolve(yes); setConfirmation(null) }} />}
    {creating && <TitleDialog heading="New notebook" submitLabel="Create" pickFolder={() => api().pickFolder()} onClose={() => setCreating(false)} onSubmit={async (title, folder) => { const created = await api().create(title, undefined, folder); onOpen?.(created.id) }} />}
  </div>
}
export default function NotebookWindow(props: { id: string; user?: UserProfile | null; navigate?: (next: Route) => void; route?: Route; onOpen?: (id: string) => void; onDeleted?: () => void; focusPageId?: string; focusToken?: number }) {
  return <MarkdownProvider><NotebookContent {...props} /></MarkdownProvider>
}
