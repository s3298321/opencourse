import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Session, UserProfile } from '@core/types'
import { TitleBarChrome } from './components/TitleBar'
import Logs from './routes/Logs'
import Settings from './routes/Settings'
import Users from './routes/Users'
import type { Route } from './routes'
import NotebookWindow from './writing-notebooks/NotebookWindow'
import TitleDialog from './writing-notebooks/TitleDialog'

/**
 * One window: pick a local user, then a standalone notebook. Settings and logs
 * sit on top of that notebook. Log out clears the in-memory session.
 */
export default function NotebookApp(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [route, setRoute] = useState<Route>({ name: 'users' })
  const [notebookId, setNotebookId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [focus, setFocus] = useState<{ pageId?: string; token: number }>({ token: 0 })
  const [error, setError] = useState('')

  const openNotebook = useCallback(async (id: string, pageId?: string) => {
    if (pageId) await window.opencourse.writing.update(id, { selectedPageId: pageId }).catch(() => undefined)
    setNotebookId(id)
    setFocus(current => ({ pageId, token: current.token + 1 }))
    setRoute({ name: 'desk' })
    setError('')
  }, [])

  const loadLibrary = useCallback(async () => {
    const notebooks = await window.opencourse.writing.list()
    setNotebookId(current => current && notebooks.some(notebook => notebook.id === current) ? current : notebooks[0]?.id ?? null)
    setError('')
  }, [])

  const navigate = useCallback((next: Route) => {
    if (next.name === 'users') {
      void window.opencourse.logout().then(nextSession => {
        setSession(nextSession)
        setUser(null)
        setNotebookId(null)
        setRoute({ name: 'users' })
        setError('')
      }).catch(cause => setError((cause as Error).message))
      return
    }
    setRoute(next)
  }, [])

  const onSessionChanged = useCallback((nextSession: Session, nextUser: UserProfile | null) => {
    setSession(nextSession)
    setUser(nextUser)
    setRoute(nextUser ? { name: 'desk' } : { name: 'users' })
    if (!nextUser) setNotebookId(null)
  }, [])

  useEffect(() => {
    void window.opencourse.getSession().then(value => {
      setSession(value)
      setUser(value.user)
      setRoute(value.user ? { name: 'desk' } : { name: 'users' })
    }).catch(cause => setError((cause as Error).message))
  }, [])

  useEffect(() => {
    if (!user) return
    window.opencourse.writing.mainReady()
    void loadLibrary().catch(cause => setError((cause as Error).message))
    return window.opencourse.writing.onChanged(() => { void loadLibrary().catch(() => undefined) })
  }, [user, loadLibrary])

  useEffect(() => window.opencourse.writing.onOpenNotebook((id, pageId) => { void openNotebook(id, pageId) }), [openNotebook])

  useEffect(() => window.opencourse.onNavigate(action => {
    if (!user) return
    if (action === 'settings') navigate({ name: 'settings', from: { name: 'desk' } })
    if (action === 'users') navigate({ name: 'users' })
  }), [navigate, user])

  const desk = route.name === 'desk'
  return <div className="app">
    {error && route.name === 'users' && <p className="import-note error">{error}</p>}
    {route.name === 'users' && <Users session={session} onSessionChanged={onSessionChanged} />}
    {user && notebookId && <div hidden={!desk}><NotebookWindow id={notebookId} user={user} navigate={navigate} route={{ name: 'desk' }} onOpen={id => { void openNotebook(id) }} onDeleted={() => { setNotebookId(null); void loadLibrary() }} focusPageId={focus.pageId} focusToken={focus.token} /></div>}
    {user && desk && !notebookId && <EmptyNotebook user={user} navigate={navigate} creating={creating} error={error} onCreate={() => setCreating(true)} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); void openNotebook(id) }} />}
    {route.name === 'settings' && <Settings user={user} navigate={navigate} route={route} onSession={next => { setSession(next); setUser(next.user) }} onSessionChanged={onSessionChanged} />}
    {route.name === 'logs' && <Logs user={user} navigate={navigate} route={route} />}
  </div>
}

function EmptyNotebook({ user, navigate, creating, error, onCreate, onClose, onCreated }: {
  user: UserProfile
  navigate: (next: Route) => void
  creating: boolean
  error: string
  onCreate: () => void
  onClose: () => void
  onCreated: (id: string) => void
}): JSX.Element {
  return <div className="app writing-window">
    <TitleBarChrome showPomodoro user={user} navigate={navigate} route={{ name: 'desk' }} />
    <div className="body">
      <div className="content content-glass scroll">
        <div className="empty">
          <h1>No notebooks yet</h1>
          <p className="meta">Notebooks you create here are the same ones OpenCourse keeps when they are not tied to a course or document.</p>
          {error && <p className="import-note error">{error}</p>}
          <button className="action-button" onClick={onCreate}>New notebook</button>
        </div>
      </div>
    </div>
    {creating && <TitleDialog heading="New notebook" submitLabel="Create" onClose={onClose} onSubmit={async title => { const notebook = await window.opencourse.writing.create(title); onCreated(notebook.id) }} />}
  </div>
}
