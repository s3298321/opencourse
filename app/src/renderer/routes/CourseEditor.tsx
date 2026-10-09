import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { currentFormat, newDraftRef } from '@core/course-document'
import type { AuthoringCourse } from '@core/course-document'
import { useConversationPanel } from '../sidechat/useChat'
import type { ChatTransport } from '../sidechat/useChat'
import ChatPanel from '../components/ChatPanel'
import { AskProvider } from '../ask-context'
import { PreviewAskOffer, usePreviewAsk } from '../sidechat/usePreviewAsk'
import { availableBlockSlug } from '@core/block-slugs'
import type { AuthoringTarget, ChatQuote, ChatSendResult, Block, CourseManifest, Flashcard, Lesson, Module, UserProfile } from '@core/types'
import { copyElement, deleteElement, editElement, locateElement, newBlock, reorderElement } from '@core/course-editor'
import type { OutlineElement } from '@core/course-editor'
import { CourseFields, ElementFields, EditorValidation, EditorAttachments } from './CourseEditorFields'
import { BlockPreview, FlashcardPreview, LessonPreview, CourseCoverPreview, ProjectPreview } from './CourseEditorPreview'
import type { PreviewEditing } from './CourseEditorPreview'
import Html from '../components/Html'
import TitleBar from '../components/TitleBar'
import BlockTypeIcon, { blockTypeLabels } from '../components/BlockTypeIcon'
import type { ConfirmRequest } from '../components/ConfirmDialog'
import type { Route, Screen } from '../routes'
import { useAuthoringMotion } from '../authoring/useAuthoringMotion'

const uuid = newDraftRef
const blockKinds: Block['type'][] = ['markdown', 'image', 'video', 'visualization', 'quiz', 'exercise']
const label = (element: OutlineElement): string => 'answer' in element ? element.id || 'Untitled card' : 'blocks' in element || 'lessons' in element || element.type === 'project' ? element.title || 'Untitled' : element.slug || 'Untitled block'
function retainCollapsed(refs: string[], manifest: CourseManifest, map?: Record<string, string>): string[] {
  return [...new Set(refs.map(ref => map?.[ref] ?? ref))].filter(ref => {
    const element = locateElement(manifest, ref)?.element
    return element && ('lessons' in element || 'blocks' in element)
  })
}
function fieldPath(manifest: CourseManifest, id: string | null): string {
  for (const [m, module] of manifest.modules.entries()) {
    if (module.nodeId === id) return `/modules/${m}`
    if (module.type === 'project') continue
    for (const [l, lesson] of module.lessons.entries()) {
      if (lesson.nodeId === id) return `/modules/${m}/lessons/${l}`
      for (const [b, block] of lesson.blocks.entries()) if (block.nodeId === id) return `/modules/${m}/lessons/${l}/blocks/${b}`
      for (const [c, card] of (lesson.flashcards ?? []).entries()) if (card.nodeId === id) return `/modules/${m}/lessons/${l}/flashcards/${c}`
    }
  }
  return ''
}

/** What App needs from an open editor to leave it safely. */
export interface EditorHandle { courseId: string; flush: () => Promise<void> }

/**
 * Nothing here is written to the course until Save. Edits - yours and the
 * assistant's - collect in main's edit session (main/edit-sessions.ts); this
 * component pushes its own there shortly after each change so the assistant
 * always works on what is on screen, and so a trip to Settings and back keeps
 * them. Leaving any other way goes through App's confirmLeave.
 */
export default function CourseEditor({ courseId, user, route, navigate, registerEditor, onDirty, ask }: {
  courseId: string; user: UserProfile | null; route: Screen; navigate: (route: Route, options?: { skipGuard?: boolean }) => void
  registerEditor: (handle: EditorHandle | null) => void
  onDirty: (dirty: boolean) => void
  ask: (request: ConfirmRequest) => Promise<boolean>
}): JSX.Element {
  const [data, setData] = useState<AuthoringCourse | null>(null)
  const [manifest, setManifest] = useState<CourseManifest | null>(null)
  const storageKey = `authoring:${user?.id ?? 'user'}:${courseId}`
  const readState = (): { mode?: string; selected?: string | null; collapsed?: unknown } => { try { return JSON.parse(localStorage.getItem(`${storageKey}:editor`) ?? '{}') ?? {} } catch { return {} } }
  const [selected, setSelected] = useState<string | null>(() => readState().selected ?? null)
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = readState().collapsed
    return Array.isArray(saved) ? saved.filter((ref): ref is string => typeof ref === 'string') : []
  })
  const [mode, setMode] = useState<'manual' | 'ai'>(() => readState().mode === 'ai' ? 'ai' : 'manual')
  const motion = useAuthoringMotion(manifest, selected, mode)
  const [chatInitialized, setChatInitialized] = useState(mode === 'ai')
  const previewAsk = usePreviewAsk(mode === 'ai', `${courseId}/${selected ?? 'overview'}`)
  const [runChatId, setRunChatId] = useState<string | null>(null)
  const selectedRef = useRef(selected); selectedRef.current = selected
  const runRef = useRef(runChatId); runRef.current = runChatId
  const request = useRef<(id: string, text: string, quote?: ChatQuote) => Promise<ChatSendResult>>(async () => ({ status: 'failed', message: 'The draft is loading.' }))
  const transport = useMemo<ChatTransport>(() => {
    const api = window.opencourse
    return { list: () => api.listAuthoringChats(courseId), get: api.getAuthoringChat, create: () => api.createAuthoringChat(courseId),
      remove: api.deleteAuthoringChat, send: (id, text, quote) => request.current(id, text, quote), cancel: api.cancelAuthoringChat,
      setModel: api.setAuthoringChatModel, setReasoning: api.setAuthoringChatReasoning, setProvider: api.setAuthoringChatProvider, onDelta: api.onAuthoringChatDelta,
      onDone: api.onAuthoringChatDone, onTitle: api.onAuthoringChatTitle, onError: api.onAuthoringChatError, onActivity: api.onAuthoringChatActivity }
  }, [courseId])
  const panel = useConversationPanel(transport, 'authoring', mode === 'ai', `${storageKey}:tabs`)
  useEffect(() => { try { localStorage.setItem(`${storageKey}:editor`, JSON.stringify({ mode, selected, collapsed })) } catch { /* Optional. */ } }, [storageKey, mode, selected, collapsed])

  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // Whether main's session differs from the saved course. Edits not yet
  // pushed there are the other half of "unsaved" (see `unsaved` below).
  const [remoteDirty, setRemoteDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const saving = useRef(false)
  const [showPreview, setShowPreview] = useState(false)
  const editingLocked = busy || runChatId !== null
  const sending = useRef(false)
  const writing = useRef(false)
  const deferredRemote = useRef<{ data: AuthoringCourse; map?: Record<string, string> } | null>(null)
  const receiveRemote = useRef<(next: AuthoringCourse, nodeRefMap?: Record<string, string>) => void>(() => {})
  const current = useRef<CourseManifest | null>(null)
  const persisted = useRef<CourseManifest | null>(null)
  const version = useRef({ revision: 0, draft: 0 })
  const queue = useRef<Promise<void>>(Promise.resolve())
  const conflicted = useRef(false)
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    const result = await window.opencourse.getAuthoringCourse(courseId)
    current.current = result.draft.manifest
    persisted.current = result.draft.manifest
    version.current = { revision: result.document.revision, draft: result.draft.draftVersion }
    conflicted.current = result.draft.baseRevision !== result.document.revision
    setConflict(conflicted.current); setRemoteDirty(result.draft.dirty === true)
    setData(result); setManifest(result.draft.manifest)
    setCollapsed(value => retainCollapsed(value, result.draft.manifest, result.document.nodeRefMap))
    setSelected(value => {
      const mapped = value ? result.document.nodeRefMap?.[value] ?? value : null
      return mapped && locateElement(result.draft.manifest, mapped) ? mapped : null
    })
    setStatus(conflicted.current ? 'These unsaved edits are based on an older version of the course. Reload the latest to keep editing.' : result.document.manifest ? '' : 'A new course is added to your library when you first save it.')
  }, [courseId])
  useEffect(() => { mounted.current = true; void load().catch((err) => setStatus(err.message)); return () => { mounted.current = false } }, [load])
  // A course added from a server is never changed in place by its learner:
  // saving makes a local copy. Say so before any edit, once per opening.
  const origin = data?.document.origin
  const learnerCopy = origin?.role === 'learner'
  const warned = useRef(false)
  useEffect(() => {
    if (!origin || origin.role !== 'learner' || warned.current) return
    warned.current = true
    void ask({
      title: 'Edit a copy of this course?',
      detail: `This course comes from ${origin.serverName}. If you make changes and save, a local copy is created and opened, and the downloaded course stays as it is and keeps receiving updates. Your progress stays with the downloaded course.`,
      confirmLabel: 'Continue', cancelLabel: 'Cancel'
    }).then((go) => { if (!go) navigate({ name: 'course', courseId }) })
  }, [origin, ask, navigate, courseId])

  /** Pushes on-screen edits into main's edit session. Nothing is saved. */
  const flush = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      if (conflicted.current) throw new Error('These edits conflict with another window. Reload the latest to keep editing.')
      while (current.current && current.current !== persisted.current) {
        const snapshot = current.current
        writing.current = true
        let result
        try { result = await window.opencourse.saveCourseDraft(courseId, snapshot, version.current.revision, version.current.draft) } finally { writing.current = false }
        if ('status' in result) {
          conflicted.current = true
          if (mounted.current) setConflict(true)
          throw new Error('The course changed in another window. Your edits remain here; reload the latest to keep editing.')
        }
        version.current.draft = result.draftVersion
        persisted.current = snapshot
        if (mounted.current) setRemoteDirty(result.dirty === true)
        if (deferredRemote.current) { const pending = deferredRemote.current; deferredRemote.current = null; receiveRemote.current(pending.data, pending.map) }
      }
    }
    queue.current = queue.current.catch(() => {}).then(run).catch((error) => { if (mounted.current) setStatus(error.message); throw error })
    return queue.current
  }, [courseId])

  useEffect(() => {
    registerEditor({ courseId, flush })
    void window.opencourse.setEditorActive(true).catch(() => {})
    return () => {
      registerEditor(null)
      void window.opencourse.setEditorActive(false).catch(() => {})
      void window.opencourse.stopCourseAuthoring(courseId).catch(() => {})
    }
  }, [registerEditor, flush, courseId])
  useEffect(() => {
    const offRun = window.opencourse.onAuthoringRunState((id, state) => {
      if (id !== courseId) return
      const finished = runRef.current !== null && state.chatId === null
      runRef.current = state.chatId; setRunChatId(state.chatId)
      if (finished) setStatus('The assistant is done. Review its changes, then save.')
    })
    void window.opencourse.getAuthoringRunState(courseId).then(state => { if (mounted.current) { runRef.current = state.chatId; setRunChatId(state.chatId) } }).catch(() => {})
    receiveRemote.current = (next, nodeRefMap) => {
      if (!mounted.current) return
      if (writing.current) { deferredRemote.current = { data: next, map: nodeRefMap }; return }
      if (current.current !== persisted.current) {
        conflicted.current = true; setConflict(true); setStatus('The course changed in another window. Your edits remain here; reload the latest to keep editing.'); return
      }
      const old = current.current
      if (old) motion.prepare(old, next.draft.manifest, runRef.current !== null)
      current.current = persisted.current = next.draft.manifest
      version.current = { revision: next.document.revision, draft: next.draft.draftVersion }
      setData(next); setManifest(next.draft.manifest); setErrors([]); setRemoteDirty(next.draft.dirty === true)
      setCollapsed(value => retainCollapsed(value, next.draft.manifest, nodeRefMap))
      setSelected(value => {
        if (!value) return null
        const mapped = nodeRefMap?.[value] ?? value
        if (locateElement(next.draft.manifest, mapped)) return mapped
        let parent = old && locateElement(old, value)?.parentId
        while (parent) { if (locateElement(next.draft.manifest, parent)) return parent; parent = old && locateElement(old, parent)?.parentId }
        return null
      })
      setStatus(runRef.current ? 'The course assistant is editing…' : '')
    }
    const offDraft = window.opencourse.onAuthoringDraftChanged((id, next, map) => { if (id === courseId) receiveRemote.current(next, map) })
    return () => { offRun(); offDraft() }
  }, [courseId])
  request.current = async (id, text, quote) => {
    if (sending.current || runRef.current || busy || conflicted.current) return { status: 'busy' }
    const snapshot = current.current, selectedId = selectedRef.current
    const location = snapshot && selectedId ? locateElement(snapshot, selectedId) : undefined
    const target: AuthoringTarget = location && selectedId ? { kind: location.kind === 'module' && 'type' in location.element && location.element.type === 'project' ? 'project' : location.kind, ref: selectedId } : { kind: 'overview' }
    sending.current = true
    try { await flush(); return await window.opencourse.sendAuthoringMessage(id, text, target, version.current.revision, version.current.draft, quote) }
    finally { sending.current = false }
  }

  // Push soon after each change: the assistant reads main's copy, and so does
  // Settings-and-back. It is memory either way.
  useEffect(() => {
    if (!manifest || current.current === persisted.current) return
    const timer = setTimeout(() => { void flush().catch(() => {}) }, 150)
    return () => clearTimeout(timer)
  }, [manifest, flush])

  const mutate = (fn: (manifest: CourseManifest) => CourseManifest): void => {
    if (!current.current || editingLocked || sending.current) return
    const next = fn(current.current)
    current.current = next; setManifest(next); setErrors([])
  }
  const save = async (): Promise<void> => {
    if (editingLocked || saving.current || !current.current) return
    saving.current = true
    setBusy(true)
    try {
      await flush()
      let result = await window.opencourse.saveCourse(courseId, version.current.revision, version.current.draft)
      if (result.status === 'confirmation-required') {
        const preview = result.preview
        const names = preview.deleted.slice(0, 12).map((n) => `• ${n.label}`).join('\n')
        if (!window.confirm(`Save and delete ${preview.deleted.length} course elements?\n\n${names}${preview.deleted.length > 12 ? '\n…' : ''}\n\nTheir progress, ${preview.messages} attached messages, and ${preview.workspaces} learner workspaces will be permanently deleted.`)) return
        result = await window.opencourse.saveCourse(courseId, version.current.revision, version.current.draft, true)
      }
      if (result.status === 'invalid') { setErrors(result.errors); setStatus('Fix the highlighted errors, then save again. Your edits are still here.'); return }
      if (result.status !== 'ok') { setStatus('The course changed in another window. Reload the latest before saving.'); conflicted.current = true; setConflict(true); return }
      if (result.copiedTo) {
        // The edits are a course of their own now; continue in its editor.
        onDirty(false)
        navigate({ name: 'courseEditor', courseId: result.copiedTo }, { skipGuard: true })
        return
      }
      const savedRefs = result.nodeRefMap
      setCollapsed(value => [...new Set(value.map(ref => savedRefs?.[ref] ?? ref))])
      setSelected(value => value ? savedRefs?.[value] ?? value : null)
      await load(); setStatus('Saved. Progress on everything you kept is preserved.'); setErrors([])
    } catch (err) { setStatus((err as Error).message) } finally { saving.current = false; setBusy(false) }
  }
  const saveHandler = useRef(save); saveHandler.current = save
  useEffect(() => {
    const onSave = (): void => { void saveHandler.current() }
    const keyboard = (event: KeyboardEvent): void => { if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); onSave() } }
    document.addEventListener('authoring:save', onSave); document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('authoring:save', onSave); document.removeEventListener('keydown', keyboard) }
  }, [])
  const reloadLatest = async (): Promise<void> => {
    if (!(await ask({ title: 'Reload the latest version?', detail: 'Edits in this window that conflict with the other window will be discarded.', confirmLabel: 'Reload', cancelLabel: 'Cancel', danger: true }))) return
    conflicted.current = false; setConflict(false); setStatus('')
    await load().catch((err) => setStatus(err.message))
  }

  const addModule = (project = false): void => {
    const nodeId = uuid()
    const module: Module = project ? { nodeId, type: 'project', slug: availableBlockSlug('project', current.current?.modules.map(m => m.slug) ?? []), title: 'New project', project: { nodeId: uuid(), definition: '', requirements: [], deliverables: [] } } : { nodeId, slug: availableBlockSlug('module', current.current?.modules.map(m => m.slug) ?? []), title: 'New module', lessons: [] }
    mutate((m) => ({ ...currentFormat(m), modules: [...m.modules, module] })); setSelected(nodeId)
  }
  const addLesson = (moduleId: string): void => {
    const nodeId = uuid()
    const lesson: Lesson = { nodeId, slug: availableBlockSlug('lesson', (current.current?.modules.find(m => m.nodeId === moduleId)?.lessons ?? []).map(l => l.slug)), title: 'New lesson', blocks: [] }
    mutate((m) => { const copy = structuredClone(m); const module = copy.modules.find((mod) => mod.nodeId === moduleId); if (module && module.type !== 'project') module.lessons.push(lesson); return copy }); setSelected(nodeId)
  }
  const addBlock = (lessonId: string): void => {
    const lesson = current.current && locateElement(current.current, lessonId)
    const block = newBlock('markdown', uuid, lesson && 'blocks' in lesson.element ? lesson.element.blocks : [])
    mutate((m) => { const copy = structuredClone(m); const found = locateElement(copy, lessonId); if (found && 'blocks' in found.element) found.element.blocks.push(block); return copy }); setSelected(block.nodeId!)
  }

  const addCard = (lessonId: string): void => {
    const nodeId = uuid()
    mutate(m => {
      const copy = structuredClone(m), found = locateElement(copy, lessonId)
      if (found && 'blocks' in found.element) {
        const cards = found.element.flashcards ??= []
        cards.push({ nodeId, id: availableBlockSlug('card', cards.map(card => card.id)), question: '', answer: '' })
      }
      return currentFormat(copy)
    })
    setSelected(nodeId)
  }
  const resetCard = async (cardId: string): Promise<void> => {
    if (!window.confirm('Reset this card’s review progress? Its schedule and rating history will be cleared immediately for you. This is independent of saving or discarding draft changes.')) return
    setBusy(true)
    try { await window.opencourse.resetFlashcardProgress(courseId, cardId); setStatus('Review progress reset. Draft content is unchanged.') }
    catch (err) { setStatus((err as Error).message) } finally { setBusy(false) }
  }
  // Unsaved: edits still on their way to main, or main's session differing
  // from the saved course. A course never saved has nothing to compare to.
  const unsaved = (manifest !== null && manifest !== persisted.current) || remoteDirty
  const neverSaved = data !== null && !data.document.manifest
  useEffect(() => { onDirty(unsaved) }, [onDirty, unsaved])
  const location = manifest && selected ? locateElement(manifest, selected) : undefined
  const previewEditing: PreviewEditing = {
    language: manifest?.runtime?.language, editable: mode === 'manual', locked: editingLocked,
    onEdit: () => { setMode('manual'); setShowPreview(true) },
    onChange: (ref, fields) => mutate(m => editElement(m, ref, fields))
  }
  const toggleCollapsed = (id: string): void => setCollapsed(value => value.includes(id) ? value.filter(ref => ref !== id) : [...value, id])
  const outlineRow = (element: OutlineElement, depth: number): JSX.Element => {
    const card = 'answer' in element
    const block = !card && !('blocks' in element) && !('lessons' in element) && element.type !== 'project' ? element as Block : null
    const description = card ? `Flashcard: ${label(element)}` : block ? `${blockTypeLabels[block.type]}: ${label(element)}` : label(element)
    const branch = 'lessons' in element || 'blocks' in element
    const expanded = !collapsed.includes(element.nodeId!)
    return <div className="outline-entry" data-authoring-outline-id={element.nodeId} style={{ paddingLeft: depth * 16 }} key={element.nodeId}>
      {branch ? <button className="outline-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label(element)}`} title={`${expanded ? 'Collapse' : 'Expand'} ${label(element)}`} onClick={() => toggleCollapsed(element.nodeId!)}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} /></svg>
      </button> : <span className="outline-toggle-space" aria-hidden="true" />}
      <button className={`outline-row${selected === element.nodeId ? ' selected' : ''}`} aria-label={description} title={description} aria-pressed={selected === element.nodeId} onClick={() => setSelected(element.nodeId!)}>
        {block ? <BlockTypeIcon type={block.type} /> : 'lessons' in element ? <svg className="outline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg> : <span className="outline-icon" aria-hidden="true">{card ? '▱' : 'blocks' in element ? '▤' : '◇'}</span>}
        <span className="outline-label">{label(element)}</span>
      </button>
    </div>
  }

  return <>
    <TitleBar user={user} route={route} navigate={navigate} back={{ label: 'All courses', onClick: () => navigate({ name: 'library' }) }} />
    <div className={`course-editor${showPreview ? ' show-preview' : ''}${mode === 'ai' ? ' ai-mode' : ''}`}>
      <header className="author-header"><div>
        <div className="author-title"><h1>{manifest?.title || 'Course editor'}</h1>{data && <span className={`author-save-state${unsaved ? ' unsaved' : ''}`} role="status" aria-live="polite">{unsaved ? 'Unsaved changes' : neverSaved ? 'Not saved yet' : 'All changes saved'}</span>}</div>
        <p role="status" className="meta">{runChatId ? 'The course assistant is editing…' : status}{conflict && <> <button className="ghost author-reload" disabled={editingLocked} onClick={() => void reloadLatest()}>Reload latest</button></>}</p>
        <div className="author-mode" role="group" aria-label="Course editing mode"><button className={mode === 'manual' ? 'active' : ''} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>Manual</button><button className={mode === 'ai' ? 'active' : ''} aria-pressed={mode === 'ai'} onClick={() => { setChatInitialized(true); setMode('ai') }}>AI</button></div>
      </div><div className="actions">
        <button className="secondary author-preview-toggle" onClick={() => setShowPreview((show) => !show)}>{showPreview ? 'Edit' : 'Preview'}</button>
        <button className="author-save" title="Save (⌘S)" disabled={editingLocked || !manifest || (!unsaved && !neverSaved)} onClick={() => void save()}>{busy ? 'Saving' : learnerCopy ? 'Save as local copy' : 'Save'}</button>
      </div></header>
      {errors.length > 0 && <div className="author-errors" role="alert"><strong>Course validation</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div>}
      {manifest && <EditorAttachments value={data?.document.attachments ?? []}><div className="author-layout">
        <aside ref={motion.outlineRef} className="author-outline scroll"><button className={`outline-row${selected === null ? ' selected' : ''}`} onClick={() => setSelected(null)}>Course details</button>
          {manifest.modules.map((module) => <div key={module.nodeId}>
            {outlineRow(module, 0)}
            {module.type !== 'project' && !collapsed.includes(module.nodeId!) && <>
              {module.lessons.map((lesson) => <div key={lesson.nodeId}>
                {outlineRow(lesson, 1)}
                {!collapsed.includes(lesson.nodeId!) && <>
                  {lesson.blocks.map((block) => outlineRow(block, 2))}
                  {mode === 'manual' && <button className="outline-add outline-add-block" disabled={editingLocked} onClick={() => addBlock(lesson.nodeId!)}><span className="outline-icon" aria-hidden="true">+</span><span>Add block</span></button>}
                  <div className="outline-card-group"><span className="meta">Flashcards ({lesson.flashcards?.length ?? 0})</span>
                    {lesson.flashcards?.map(card => outlineRow(card, 2))}
                    {mode === 'manual' && <button className="outline-add" disabled={editingLocked} onClick={() => addCard(lesson.nodeId!)}>+ Add card</button>}
                  </div>
                </>}
              </div>)}
              {mode === 'manual' && <button className="outline-add" disabled={editingLocked} onClick={() => addLesson(module.nodeId!)}>+ Add lesson</button>}
            </>}
          </div>)}
          {mode === 'manual' && <div className="outline-bottom"><button className="secondary" disabled={editingLocked} onClick={() => addModule()}>Add module</button><button className="secondary" disabled={editingLocked} onClick={() => addModule(true)}>Add project</button></div>}
        </aside>
        <section hidden={mode === 'ai'} className={`author-form scroll${location?.kind === 'block' && (location.element as Block).type === 'markdown' ? ' author-form-markdown' : ''}`}><fieldset disabled={editingLocked} inert={editingLocked}>
          {location && selected && <div className="author-element-actions actions">
            <button className="ghost" disabled={location.index === 0} onClick={() => mutate((m) => reorderElement(m, selected, -1))}>↑ Move up</button><button className="ghost" disabled={location.index === location.siblings.length - 1} onClick={() => mutate((m) => reorderElement(m, selected, 1))}>↓ Move down</button>
            <button className="ghost" onClick={() => { const result = copyElement(current.current!, selected, uuid); mutate(() => result.manifest); setSelected(result.id) }}>Duplicate</button>
            <button className="ghost" onClick={() => { mutate((m) => deleteElement(m, selected)); setSelected(null) }}>Delete</button>
            {location.kind === 'flashcard' && <>
              {data?.document.manifest?.modules.some(module => module.type !== 'project' && module.lessons.some(lesson => lesson.flashcards?.some(card => card.nodeId === selected))) && <button className="ghost" onClick={() => void resetCard(selected)}>Reset review progress</button>}
            </>}
            {location.kind === 'block' && <label className="author-action-field">Block type<select aria-label="Change block type" value={(location.element as Block).type} onChange={(e) => { const block = newBlock(e.target.value as Block['type'], uuid, location.siblings as Block[]); mutate((m) => { const copy = structuredClone(m); const found = locateElement(copy, selected); if (found) found.siblings.splice(found.index, 1, block); return copy }); setSelected(block.nodeId!) }}>{blockKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>}
          </div>}
          <EditorValidation value={{ path: fieldPath(manifest, selected), errors }}>
            {location && selected ? <ElementFields key={`${selected}/${data?.document.revision}/${data?.draft.draftVersion}`} element={location.element} manifest={manifest} courseId={courseId} set={(fields) => mutate((m) => editElement(m, selected, fields))} /> : <CourseFields manifest={manifest} courseId={courseId} versionHint={origin?.role === 'publisher' ? `Last published as v${origin.version} on ${origin.serverName}. Publishing again needs a higher version.` : undefined} set={(fields) => mutate((m) => ({ ...m, ...fields }))} />}
          </EditorValidation>
        </fieldset></section>
        <AskProvider value={previewAsk.ask}><section ref={motion.previewRef} className="author-preview scroll" data-ask={mode === 'ai' ? 'preview' : undefined}><div className="author-preview-label" data-ask="none">Preview</div><div className="author-preview-part" data-authoring-preview-key={selected ?? 'overview'}>
          {!location ? <><CourseCoverPreview courseId={courseId} path={manifest.cover_image} /><h1>{manifest.title}</h1>{manifest.description && <Html className="prose" source={manifest.description} />}</> : 'blocks' in location.element ? <LessonPreview key={selected} lesson={location.element} manifest={manifest} courseId={courseId} {...previewEditing} /> : 'project' in location.element ? <><h1>{location.element.title}</h1><ProjectPreview project={location.element.project} /></> : 'lessons' in location.element ? <><h1>{location.element.title}</h1>{location.element.lessons.map((lesson) => <p key={lesson.nodeId}>{lesson.title}</p>)}</> : 'answer' in location.element ? <FlashcardPreview key={selected} card={location.element as Flashcard} courseId={courseId} /> : <BlockPreview key={selected} block={location.element as Block} courseId={courseId} {...previewEditing} />}
        </div></section></AskProvider>
        {chatInitialized && <div className="author-chat-column" hidden={mode !== 'ai'}><ChatPanel variant="authoring" storageKey={storageKey} panel={{ ...panel, busy: runChatId ? new Set([...panel.busy, runChatId]) : panel.busy, sendBlocked: editingLocked || conflicted.current }} quote={previewAsk.quote} onQuoteUsed={previewAsk.clearQuote} onAddKey={() => navigate({ name: 'settings', from: route })} /></div>}
      </div></EditorAttachments>}
    </div>
    <PreviewAskOffer offer={previewAsk.selection} attach={previewAsk.ask.attach} />
  </>
}
