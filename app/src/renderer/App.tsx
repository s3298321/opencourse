import DocumentOverview from './routes/DocumentOverview'
import DocumentServerCatalog from './routes/DocumentServerCatalog'
import CatalogDocument from './routes/CatalogDocument'
import DocumentPublication from './routes/DocumentPublication'
import Notebook, { type NotebookHandle } from './routes/Notebook'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Users from './routes/Users'
import Library from './routes/Library'
import ServerCatalog from './routes/ServerCatalog'
import Documents from './routes/Documents'
import DocumentReader from './routes/Document'
import type { ReadingSource } from '@core/documents/types'
import CourseEditor from './routes/CourseEditor'
import CourseDetail from './routes/CourseDetail'
import CatalogCourse from './routes/CatalogCourse'
import Publication from './routes/Publication'
import Review from './routes/Review'
import LessonView from './routes/Lesson'
import Project from './routes/Project'
import Coach from './routes/Coach'
import CoachProject from './routes/CoachProject'
import CoachTranscript from './routes/CoachTranscript'
import Settings from './routes/Settings'
import Logs from './routes/Logs'
import Search from './components/Search'
import ConfirmDialog, { type ConfirmRequest } from './components/ConfirmDialog'
import { MarkdownProvider } from './markdown-context'
import type { CourseView, Session, UserProfile } from '@core/types'
import { screenOf, sectionOf, type Route, type Screen } from './routes'
import type { EditorHandle } from './routes/CourseEditor'
import AppShell from './components/AppShell'
import { ScreenHost } from './screen-activity'
import { initialNavigation, navigateWorkspace, screenKey, switchWorkspace as restoreWorkspace, type Workspace } from './workspaces'

export default function App(): JSX.Element {
  // The app opens on the picker: main starts every launch with no user
  // selected, and nothing user-scoped can be fetched until one is.
  const [navigation, setNavigation] = useState(initialNavigation)
  const route = navigation.route
  const navigationRef = useRef(navigation)
  navigationRef.current = navigation
  const setRoute = useCallback((next: Route | ((current: Route) => Route)) => {
    setNavigation(current => navigateWorkspace(current, typeof next === 'function' ? next(current.route) : next))
  }, [])
  const switchWorkspace = useCallback((section: Workspace) => {
    if (restoreWorkspace(navigationRef.current, section) === navigationRef.current) return
    setSearchCourse(null)
    setNavigation(current => restoreWorkspace(current, section))
  }, [])
  const [session, setSession] = useState<Session | null>(null)
  const [navSignal, setNavSignal] = useState<{ action: 'prev' | 'next'; n: number } | null>(null)
  const [importSignal, setImportSignal] = useState(0)
  const [documentImportSignal, setDocumentImportSignal] = useState(0)
  const [documentFindSignal, setDocumentFindSignal] = useState(0)
  const [coachNewSignal, setCoachNewSignal] = useState(0)
  const [searchCourse, setSearchCourse] = useState<CourseView | null>(null)
  // Shared across lessons; the mounted workspace also retains its chat draft.
  const [chatOpen, setChatOpen] = useState(false)
  // Tag the reader's offset so lesson navigation restores only the right lesson.
  const lessonScroll = useRef({ key: '', top: 0 })
  // And the reader's text size, for the same reason and one more: the lesson
  // restores its scroll offset as soon as it has a course to show, so the size
  // has to be known by then - fetched by a remounting lesson, it would arrive
  // after the offset and move the text out from under it. Null until read.
  const [readingScale, setReadingScale] = useState<number | null>(null)

  // The course editor that is open - mounted, or parked under Settings or Logs.
  // Leaving it is the one navigation that can lose work, so every way out goes
  // through confirmLeave: Back, the menu, switching user. Its edits live in
  // main until Save, which is what lets a parked editor be asked too.
  const notebook = useRef<NotebookHandle | null>(null)
  const registerNotebook = useCallback((handle: NotebookHandle | null) => { notebook.current = handle }, [])
  const editor = useRef<EditorHandle | null>(null)
  const registerEditor = useCallback((handle: EditorHandle | null) => { editor.current = handle }, [])
  const editorDirty = useRef(false)
  const onEditorDirty = useCallback((dirty: boolean) => { editorDirty.current = dirty }, [])
  const routeRef = useRef(route)
  routeRef.current = route
  const [question, setQuestion] = useState<{ request: ConfirmRequest; resolve: (yes: boolean) => void } | null>(null)
  const ask = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    setQuestion({ request, resolve: (yes) => { setQuestion(null); resolve(yes) } })
  }), [])

  /** True when it is fine to go to `next`; null means "somewhere else entirely". */
  const confirmLeave = useCallback(async (next: Route | null): Promise<boolean> => {
    const current = navigationRef.current.courses
    // Returning to a retained notebook must remain possible to resolve a save conflict.
    const returningToNotebook = current?.name === 'lesson' && next?.name === 'notebook' && current.courseId === next.courseId
    if (navigationRef.current.reader?.notebook && notebook.current && !returningToNotebook) {
      try { await notebook.current.flush() } catch { return false }
    }
    if (current?.name !== 'courseEditor') return true
    // Changing halves parks the editor. Replacing it or changing user leaves it.
    if (next && next.name !== 'users' && sectionOf(next) !== 'courses') return true
    const courseId = current.courseId
    if (editor.current) await editor.current.flush().catch(() => {})
    // Settings and Logs open over the editor; its session waits underneath.
    if (next && screenOf(next).name === 'courseEditor' && (screenOf(next) as { courseId: string }).courseId === courseId) return true
    const dirty = editorDirty.current || await window.opencourse.isCourseDraftDirty(courseId).catch(() => false)
    const running = (await window.opencourse.getAuthoringRunState(courseId)).chatId !== null
    if ((dirty || running) && !(await ask({
      title: dirty ? 'Discard unsaved changes?' : 'Stop the assistant and leave?',
      detail: [dirty ? 'Your edits to this course have not been saved. Discarding them leaves the course as it was last saved.' : '', running ? 'The assistant is still working. Leaving stops it.' : ''].filter(Boolean).join(' '),
      confirmLabel: dirty ? 'Discard changes' : 'Stop and leave',
      cancelLabel: 'Keep editing',
      confirmIcon: dirty ? 'trash' : 'stop',
      cancelIcon: 'edit',
      danger: true
    }))) return false
    editorDirty.current = false
    await window.opencourse.discardCourseDraft(courseId).catch(() => {})
    return true
  }, [ask])

  const navigate = useCallback((next: Route, options?: { keepScroll?: boolean; skipGuard?: boolean }, origin?: Workspace) => {
    void (async () => {
    if (!options?.skipGuard && !(await confirmLeave(next))) return
    const parked = origin && sectionOf(routeRef.current) !== origin
    if (parked) {
      setNavigation(current => ({ ...navigateWorkspace(current, next), route: current.route }))
      return
    }
    const returning = (routeRef.current.name === 'settings' || routeRef.current.name === 'logs') && next === screenOf(routeRef.current)
    const previous = screenOf(routeRef.current)
    const readerSwitch = (next.name === 'lesson' || next.name === 'notebook') && (previous.name === 'lesson' || previous.name === 'notebook') && next.name !== previous.name && next.courseId === previous.courseId
    setSearchCourse(null)
    setRoute(next)
    if (!returning && !readerSwitch && !options?.keepScroll && next.name !== 'settings' && next.name !== 'logs' && next.name !== 'project') {
      requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.screen-host .content')].find(element => element.checkVisibility({ visibilityProperty: true }))?.scrollTo({ top: 0 }))
    }
    })().catch(() => {})
  }, [confirmLeave])

  const coursesNavigate = useCallback((next: Route, options?: { keepScroll?: boolean; skipGuard?: boolean }) => navigate(next, options, 'courses'), [navigate])
  const coachNavigate = useCallback((next: Route, options?: { keepScroll?: boolean; skipGuard?: boolean }) => navigate(next, options, 'coach'), [navigate])
  const documentsNavigate = useCallback((next: Route, options?: { keepScroll?: boolean; skipGuard?: boolean }) => navigate(next, options, 'documents'), [navigate])

  useEffect(() => { const online=()=>{void window.opencourse.syncLearning().catch(()=>{})};window.addEventListener('online',online);return()=>window.removeEventListener('online',online) }, [])
  useEffect(() => {
    const source = (event: Event): void => {
      const ref = (event as CustomEvent<ReadingSource>).detail
      if (ref?.kind === 'course') navigate(ref.lessonId ? { name: 'lesson', courseId: ref.courseId, moduleId: ref.moduleId, lessonId: ref.lessonId } : { name: 'project', courseId: ref.courseId, moduleId: ref.moduleId })
    }
    window.addEventListener('reading:source', source)
    return () => window.removeEventListener('reading:source', source)
  }, [navigate])

  // Closing or reloading the window with unsaved edits: main asks natively
  // (will-prevent-unload), because a page that is unloading cannot.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (editorDirty.current || notebook.current?.dirty()) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    void window.opencourse.getSession().then(setSession)
  }, [])

  // The titlebar is a window drag region, and macOS hands a press inside one to
  // the window before Chromium ever sees it - whatever is painted on top. A
  // fullscreen visualization is painted on top of it, so its controls in the
  // top 38px did nothing while every other click worked. styles.css turns the
  // region off under this attribute.
  useEffect(() => {
    const sync = (): void => {
      document.documentElement.toggleAttribute('data-fullscreen', Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  useEffect(() => {
    return window.opencourse.onNavigate((action) => {
      void (async () => {
      if (action === 'coach') { switchWorkspace('coach'); return }
      if (action === 'documents') { switchWorkspace('documents'); return }
      if (action === 'importDocument') { setRoute({ name: 'documents' }); setDocumentImportSignal(value => value + 1); return }
      if (action === 'library' && sectionOf(routeRef.current) === 'documents') { setRoute({ name: 'documents' }); return }
      if (action === 'library' && sectionOf(routeRef.current) === 'coach') { switchWorkspace('courses'); return }
      if (action === 'saveCourse') {
        if (routeRef.current.name !== 'courseEditor') return
        // Course ▸ Save Course (⌘S) is only enabled while an editor is mounted.
        document.dispatchEvent(new Event('authoring:save'))
        return
      }
      if (action === 'search' || action === 'prev' || action === 'next') {
        if (action === 'search') {
          if (routeRef.current.name === 'document') { setDocumentFindSignal(value => value + 1); return }
          setRoute((current) => {
            // Only a course has anything to search in.
            if (current.name === 'course' || current.name === 'lesson' || current.name === 'project' || current.name === 'notebook') {
              void window.opencourse.getCourse(current.courseId).then(setSearchCourse)
            }
            return current
          })
        } else setNavSignal((prev) => ({ action, n: (prev?.n ?? 0) + 1 }))
        return
      }
      const target: Route | null =
        action === 'library' || action === 'import' ? { name: 'library' }
          : action === 'users' ? { name: 'users' }
          : action === 'coachNew' ? { name: 'coach' }
          : action === 'settings' ? { name: 'settings', from: screenOf(routeRef.current) }
          : null
      if (!(await confirmLeave(target))) return
      if (action === 'library') {
        setSearchCourse(null)
        setRoute({ name: 'library' })
      } else if (action === 'users') {
        setSearchCourse(null)
        setRoute({ name: 'users' })
      } else if (action === 'coachNew') {
        setSearchCourse(null)
        setRoute({ name: 'coach' })
        setCoachNewSignal((n) => n + 1)
      } else if (action === 'courseNew') {
        const { document } = await window.opencourse.createCourse()
        setRoute({ name: 'courseEditor', courseId: document.courseId })
      } else if (action === 'import') {
        setRoute({ name: 'library' })
        setImportSignal((n) => n + 1)
      } else if (action === 'settings') {
        setSearchCourse(null)
        // ⌘, from inside settings is a no-op rather than a route that
        // remembers itself as the way out; from Logs it hands Logs' own way out along.
        setRoute((current) => (current.name === 'settings' ? current : { name: 'settings', from: screenOf(current) }))
      }
      })().catch(() => {})
    })
  }, [confirmLeave, setRoute, switchWorkspace])

  // Open external links in the system browser instead of inside the app.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a')
      const href = anchor?.getAttribute('href')
      if (href && /^https?:\/\//i.test(href)) {
        event.preventDefault()
        void window.opencourse.openExternal(href)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Two callbacks, because a rename and a switch are not the same event. A
  // rename changes who you are called without changing where you are, and
  // folding it into the navigating one would leave the titlebar showing the old
  // name until something unrelated moved.
  const onSession = useCallback((next: Session) => setSession(next), [])

  const onSessionChanged = useCallback(
    (next: Session, user: UserProfile | null) => {
      setSession(next)
      setChatOpen(false)
      lessonScroll.current = { key: '', top: 0 }
      editorDirty.current = false
      setSearchCourse(null)
      setImportSignal(0)
      setDocumentImportSignal(0)
      setDocumentFindSignal(0)
      setCoachNewSignal(0)
      setNavSignal(null)
      setNavigation(navigateWorkspace(initialNavigation(), user ? { name: 'library' } : { name: 'users' }))
    },
    []
  )

  const user = session?.user ?? null
  const userId = user?.id ?? null
  // Per user: read again whenever the user changes, and nothing to read before one is picked.
  useEffect(() => {
    let alive = true
    setReadingScale(null)
    if (userId) void window.opencourse.getReadingScale().then((scale) => { if (alive) setReadingScale(scale) })
    return () => { alive = false }
  }, [userId])
  const changeReadingScale = useCallback((scale: number) => {
    setReadingScale(scale)
    // Main snaps it to a step and says what it kept; a failed write keeps the
    // size on screen for this session rather than taking it back.
    void window.opencourse.setReadingScale(scale).then(setReadingScale).catch(() => {})
  }, [])
  const renderScreen = (screen: Screen, active: boolean): JSX.Element => {
    const screenNavigate = sectionOf(screen) === 'coach' ? coachNavigate : sectionOf(screen) === 'documents' ? documentsNavigate : coursesNavigate
    switch (screen.name) {
      case 'users': return <Users session={session} onSessionChanged={onSessionChanged} />
      case 'library': return <Library user={user} navigate={screenNavigate} importSignal={importSignal} route={screen} />
      case 'catalog': return <ServerCatalog serverId={screen.serverId} user={user} navigate={screenNavigate} route={screen} />
      case 'documents': return <Documents user={user} navigate={screenNavigate} importSignal={documentImportSignal} onImportHandled={() => setDocumentImportSignal(0)} route={screen} />
      case 'documentOverview': return <DocumentOverview documentId={screen.documentId} user={user} navigate={screenNavigate} route={screen} />
      case 'documentCatalog': return <DocumentServerCatalog serverId={screen.serverId} user={user} navigate={screenNavigate} route={screen} />
      case 'catalogDocument': return <CatalogDocument serverId={screen.serverId} documentId={screen.documentId} user={user} navigate={screenNavigate} route={screen} />
      case 'documentPublication': return <DocumentPublication serverId={screen.serverId} documentId={screen.documentId} user={user} navigate={screenNavigate} route={screen} ask={ask} />
      case 'document': return <DocumentReader documentId={screen.documentId} user={user} navigate={screenNavigate} route={screen} navSignal={navSignal} findSignal={documentFindSignal} />
      case 'courseEditor': return <CourseEditor courseId={screen.courseId} user={user} navigate={screenNavigate} route={screen} registerEditor={registerEditor} onDirty={onEditorDirty} ask={ask} />
      case 'catalogCourse': return <CatalogCourse serverId={screen.serverId} courseId={screen.courseId} user={user} navigate={screenNavigate} route={screen} />
      case 'publication': return <Publication serverId={screen.serverId} courseId={screen.courseId} user={user} navigate={screenNavigate} route={screen} ask={ask} />
      case 'course': return <CourseDetail courseId={screen.courseId} user={user} navigate={screenNavigate} route={screen} />
      case 'review': return <Review initialSession={screen.session} navigate={screenNavigate} active={active} />
      case 'lesson': return <LessonView courseId={screen.courseId} moduleId={screen.moduleId} lessonId={screen.lessonId}
        pythonCellsActive={section === 'courses' && navigation.reader?.courseId === screen.courseId}
        user={user} navigate={screenNavigate} navSignal={navSignal} route={screen} chatOpen={chatOpen} setChatOpen={setChatOpen}
        scrollRef={lessonScroll} readingScale={readingScale} setReadingScale={changeReadingScale} />
      case 'notebook': return <Notebook courseId={screen.courseId} user={user} navigate={screenNavigate} route={screen} chatOpen={chatOpen} setChatOpen={setChatOpen} textScale={readingScale ?? 1} registerNotebook={registerNotebook} />
      case 'project': return <Project courseId={screen.courseId} moduleId={screen.moduleId} user={user} navigate={screenNavigate} route={screen} active={active} navSignal={navSignal} />
      case 'coach': return <Coach user={user} navigate={screenNavigate} newSignal={coachNewSignal} route={screen} />
      case 'coachProject': return <CoachProject projectId={screen.projectId} user={user} navigate={screenNavigate} route={screen} />
      case 'coachSession': return <CoachTranscript projectId={screen.projectId} sessionId={screen.sessionId} user={user} navigate={screenNavigate} route={screen} />
    }
  }
  const section = sectionOf(route)
  const overlay = route.name === 'settings' || route.name === 'logs'

  return <MarkdownProvider>
    <AppShell key={userId ?? 'picker'} user={user} route={route} navigate={navigate} switchWorkspace={switchWorkspace}>
      {(['courses', 'documents', 'coach'] as const).map(workspace => {
        const screen = navigation[workspace]
        const active = section === workspace && !overlay
        return screen && <ScreenHost key={workspace} active={active} className={`workspace-${workspace}${screen.name === 'project' ? ' project-screen' : ''}${screen.name === 'review' ? ' review-screen-host' : ''}`}>
          {workspace === 'courses' && navigation.reader ? <div className="screen-content course-reader-host" key={`reader/${navigation.reader.courseId}`}>
            {([navigation.reader.lesson, navigation.reader.notebook]).map(reader => reader && <ScreenHost key={reader.name} active={active && screen.name === reader.name} className={`reader-${reader.name}`}>
              {renderScreen(reader, active && screen.name === reader.name)}
            </ScreenHost>)}
          </div> : <div className="screen-content" key={screenKey(screen)}>{renderScreen(screen, active)}</div>}
        </ScreenHost>
      })}
      {route.name === 'users' && <ScreenHost active>{renderScreen(route, true)}</ScreenHost>}
      {route.name === 'settings' && <ScreenHost active><Settings user={user} navigate={navigate} route={route} onSession={onSession} onSessionChanged={onSessionChanged} /></ScreenHost>}
      {route.name === 'logs' && <ScreenHost active><Logs user={user} navigate={navigate} route={route} /></ScreenHost>}
      {searchCourse && <Search course={searchCourse} navigate={navigate} onClose={() => setSearchCourse(null)} />}
      {question && <ConfirmDialog request={question.request} onResult={question.resolve} />}
    </AppShell>
  </MarkdownProvider>
}
