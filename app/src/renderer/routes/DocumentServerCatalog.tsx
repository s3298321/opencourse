import { useEffect, useState } from 'react'
import type { ServerConnection, UserProfile } from '@core/types'
import type { Route, Screen } from '../routes'
import TitleBar from '../components/TitleBar'
import { DocumentCatalog } from '../learning/DocumentCatalog'

/** Documents → a server → Add documents: ServerCatalog's twin, back to that server's documents. */
export default function DocumentServerCatalog({ serverId, user, navigate, route }: {
  serverId: string; user: UserProfile | null; navigate: (route: Route) => void; route: Screen
}) {
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  useEffect(() => {
    const load = () => { void window.opencourse.listServers().then(setServers).catch(() => setServers([])) }
    load(); return window.opencourse.onServersChanged(load)
  }, [])
  const server = servers?.find(connection => connection.id === serverId) ?? null
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Documents', onClick: () => navigate({ name: 'documents', source: serverId }) }} />
    <div className="body"><div className="content content-glass scroll"><div className="library server-catalog">
      <h1 title={server?.url}>{server?.name ?? 'Documents'}</h1>
      <DocumentCatalog server={server} loadingServer={servers === null} navigate={navigate} route={route} />
    </div></div></div>
  </>
}
