import { useCallback, useEffect, useState } from 'react'
import type { CourseSummary, ServerConnection, UserProfile } from '@core/types'
import type { Route, Screen } from '../routes'
import TitleBar from '../components/TitleBar'
import Catalog from '../components/Catalog'

export default function ServerCatalog({ serverId, user, navigate, route }: {
  serverId: string; user: UserProfile | null; navigate: (route: Route) => void; route: Screen
}) {
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  useEffect(() => {
    const load = () => { void window.opencourse.listServers().then(setServers).catch(() => setServers([])) }
    load(); return window.opencourse.onServersChanged(load)
  }, [])
  const server = servers?.find(connection => connection.id === serverId) ?? null
  const [library, setLibrary] = useState<CourseSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void window.opencourse.listCourses().then((courses) => { setLibrary(courses); setError(null) })
      .catch((err) => setError(err.message))
  }, [])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onCoursesChanged(refresh), [refresh])
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Courses', onClick: () => navigate({ name: 'library', source: serverId }) }} />
    <div className="body"><div className="content content-glass scroll"><div className="library server-catalog">
      <h1 title={server?.url}>{server?.name ?? 'Catalog'}</h1>
      {error && <p className="import-note error" role="alert">{error}</p>}
      <Catalog server={server} loadingServer={servers === null} navigate={navigate} route={route} library={library} onAdded={refresh} />
    </div></div></div>
  </>
}
