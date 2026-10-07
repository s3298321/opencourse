import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Users from './routes/Users'
import Library from './routes/Library'
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
import { screenOf, type Route } from './routes'
import type { EditorHandle } from './routes/CourseEditor'
import { useScreenEntrance } from './screen-motion'

export default function App(): JSX.Element {
  // The app opens on the picker: main starts every launch with no user
  // selected, and nothing user-scoped can be fetched until one is.
  const [route, setRoute] = useState<Route>({ name: 'users' })
  useScreenEntrance(route)
  const [session, setSession] = useState<Session | null>(null)
  const [navSignal, setNavSignal] = useState<{ action: 'prev' | 'next'; n: number } | null>(null)
  const [importSignal, setImportSignal] = useState(0)
  const [coachNewSignal, setCoachNewSignal] = useState(0)
  const [searchCourse, setSearchCourse] = useState<CourseView | null>(null)
  // Lifted out of Lesson so a trip to settings and back does not close it. The
  // thread itself is a database row and would survive either way; what would
  // not is the panel being open, which is the part the learner arranged.
  const [chatOpen, setChatOpen] = useState(false)
  // Same reason, for the reading position: a ref inside Lesson would not
  // outlive the unmount that opening settings causes.
  const lessonScroll = useRef({ key: '', top: 0 })

  // The course editor that is open - mounted, or parked under Settings or Logs.
  // Leaving it is the one navigation that can lose work, so every way out goes
  // through confirmLeave: Back, the menu, switching user. Its edits live in
  // main until Save, which is what lets a parked editor be asked too.
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
    const current = screenOf(routeRef.current)
    if (current.name !== 'courseEditor') return true
    const courseId = current.courseId
    if (editor.current) await editor.current.flush().catch(() => {})
    // Settings and Logs open over the editor; its session waits underneath.
    if (next && screenOf(next).name === 'courseEditor' && (screenOf(next) as { courseId: string }).courseId === courseId) return true
    const dirty = editorDirty.current || await window.opencourse.isCourseDraftDirty(courseId).catch(() => false)
    if (dirty && !(await ask({
      title: 'Discard unsaved changes?',
      detail: 'Your edits to this course have not been saved. Discarding them leaves the course as it was last saved.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true
    }))) return false
    editorDirty.current = false
    await window.opencourse.discardCourseDraft(courseId).catch(() => {})
    return true
  }, [ask])

  const navigate = useCallback((next: Route, options?: { keepScroll?: boolean; skipGuard?: boolean }) => {
    void (async () => {
    if (!options?.skipGuard && !(await confirmLeave(next))) return
    setSearchCourse(null)
    setRoute(next)
    if (!options?.keepScroll && next.name !== 'settings' && next.name !== 'logs' && next.name !== 'project') document.querySelector('.content')?.scrollTo({ top: 0 })
    })().catch(() => {})
  }, [confirmLeave])

  // Closing or reloading the window with unsaved edits: main asks natively
  // (will-prevent-unload), because a page that is unloading cannot.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (screenOf(routeRef.current).name === 'courseEditor' && editorDirty.current) { event.preventDefault(); event.returnValue = '' }
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
      if (action === 'saveCourse') {
        // Course ▸ Save Course (⌘S) is only enabled while an editor is mounted.
        document.dispatchEvent(new Event('authoring:save'))
        return
      }
      if (action === 'search' || action === 'prev' || action === 'next') {
        if (action === 'search') {
          setRoute((current) => {
            // Only a course has anything to search in.
            if (current.name === 'course' || current.name === 'lesson' || current.name === 'project') {
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
          : action === 'coach' || action === 'coachNew' ? { name: 'coach' }
          : action === 'settings' ? { name: 'settings', from: screenOf(routeRef.current) }
          : null
      if (!(await confirmLeave(target))) return
      if (action === 'library') {
        setSearchCourse(null)
        setRoute({ name: 'library' })
      } else if (action === 'users') {
        setSearchCourse(null)
        setRoute({ name: 'users' })
      } else if (action === 'coach') {
        setSearchCourse(null)
        setRoute({ name: 'coach' })
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
  }, [confirmLeave])

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
      navigate(user ? { name: 'library' } : { name: 'users' })
    },
    [navigate]
  )

  const user = session?.user ?? null
  // Kept mounted, hidden, under an overlay - a project's draft and a review's
  // place survive a trip to Settings or Logs.
  const underneath = screenOf(route)
  const projectRoute = underneath.name === 'project' ? underneath : null
  const reviewRoute = underneath.name === 'review' ? underneath : null

  return (
    <MarkdownProvider>
      <div className="app">
        {reviewRoute && <div className="review-screen-host" hidden={route.name !== 'review'}><Review key={`${user?.id}/${reviewRoute.session.id}`} initialSession={reviewRoute.session} navigate={navigate} active={route.name === 'review'} /></div>}
        {route.name === 'users' && <Users session={session} onSessionChanged={onSessionChanged} />}
        {route.name === 'library' && (
          <Library user={user} navigate={navigate} importSignal={importSignal} route={route} />
        )}
        {route.name === 'courseEditor' && <CourseEditor key={route.courseId} courseId={route.courseId} user={user} navigate={navigate} route={route} registerEditor={registerEditor} onDirty={onEditorDirty} ask={ask} />}
        {route.name === 'catalogCourse' && (
          <CatalogCourse key={`${route.serverId}/${route.courseId}`} serverId={route.serverId} courseId={route.courseId} user={user} navigate={navigate} route={route} />
        )}
        {route.name === 'publication' && (
          <Publication key={`${route.serverId}/${route.courseId}`} serverId={route.serverId} courseId={route.courseId} user={user} navigate={navigate} route={route} ask={ask} />
        )}
        {route.name === 'course' && (
          <CourseDetail courseId={route.courseId} user={user} navigate={navigate} route={route} />
        )}
        {route.name === 'lesson' && (
          <LessonView
            courseId={route.courseId}
            moduleId={route.moduleId}
            lessonId={route.lessonId}
            user={user}
            navigate={navigate}
            navSignal={navSignal}
            route={route}
            chatOpen={chatOpen}
            setChatOpen={setChatOpen}
            scrollRef={lessonScroll}
          />
        )}
        {projectRoute && <div className="project-screen" hidden={route.name !== 'project'}>
          <Project key={`${user?.id}/${projectRoute.courseId}/${projectRoute.moduleId}`} courseId={projectRoute.courseId} moduleId={projectRoute.moduleId} user={user} navigate={navigate} route={projectRoute} active={route.name === 'project'} navSignal={navSignal} />
        </div>}
        {route.name === 'coach' && (
          <Coach user={user} navigate={navigate} newSignal={coachNewSignal} route={route} />
        )}
        {route.name === 'coachProject' && (
          <CoachProject projectId={route.projectId} user={user} navigate={navigate} route={route} />
        )}
        {route.name === 'coachSession' && (
          <CoachTranscript
            projectId={route.projectId}
            sessionId={route.sessionId}
            user={user}
            navigate={navigate}
            route={route}
          />
        )}
        {route.name === 'settings' && (
          <Settings
            user={user}
            navigate={navigate}
            route={route}
            onSession={onSession}
            onSessionChanged={onSessionChanged}
          />
        )}
        {route.name === 'logs' && <Logs user={user} navigate={navigate} route={route} />}
        {searchCourse && (
          <Search course={searchCourse} navigate={navigate} onClose={() => setSearchCourse(null)} />
        )}
        {question && <ConfirmDialog request={question.request} onResult={question.resolve} />}
      </div>
    </MarkdownProvider>
  )
}
