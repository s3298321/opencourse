import CoachLauncher from '../coach/CoachLauncher'
import { FloatingNotebooks } from '../writing-notebooks/NotebookLauncher'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { UserProfile } from '@core/types'
import type { Route } from '../routes'
import type { Workspace } from '../workspaces'
import { TitleBarChrome, type TitleBarProps } from './TitleBar'

interface ShellControls {
  declareTitleBar: (props: TitleBarProps) => void
}
const ShellContext = createContext<ShellControls | null>(null)
export const useAppShell = (): ShellControls | null => useContext(ShellContext)

/** Chrome remains mounted while screen declarations change underneath it. */
export default function AppShell({ children, route, user, navigate, switchWorkspace }: {
  children?: ReactNode; route: Route; user: UserProfile | null
  navigate: (route: Route) => void; switchWorkspace: (section: Workspace) => void
}) {
  const [declaration, setDeclaration] = useState<TitleBarProps | null>(null)
  const declareTitleBar = useCallback((props: TitleBarProps) => setDeclaration(props), [])
  const controls = useMemo(() => ({ declareTitleBar }), [declareTitleBar])
  // A newly loading screen has no declaration yet. Never show the old screen's actions.
  const current = declaration?.route === route ? declaration : {}
  return <ShellContext.Provider value={controls}>
    <div className="app">
      <TitleBarChrome {...current} route={route} user={user} navigate={navigate} switchWorkspace={switchWorkspace} />
      {children}
      {user && route.name !== 'users' && <div className="floating-launchers" key={user.id}><CoachLauncher route={route} userId={user.id} navigate={navigate} /><FloatingNotebooks route={route} userId={user.id} /></div>}
    </div>
  </ShellContext.Provider>
}
