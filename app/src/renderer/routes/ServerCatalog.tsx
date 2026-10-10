import { useCallback, useEffect, useState } from 'react'
import type { CourseSummary, UserProfile } from '@core/types'
import type { Route, Screen } from '../routes'
import TitleBar from '../components/TitleBar'
import Catalog from '../components/Catalog'

export default function ServerCatalog({ serverId, user, navigate, route }: {
  serverId: string; user: UserProfile | null; navigate: (route: Route) => void; route: Screen
}) {
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
      <h1>Add courses</h1>
      <p className="lede">Browse this server’s catalog and add courses to your library.</p>
      {error && <p className="import-note error" role="alert">{error}</p>}
      <Catalog serverId={serverId} navigate={navigate} route={route} library={library} onAdded={refresh} />
    </div></div></div>
  </>
}
