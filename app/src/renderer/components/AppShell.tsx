import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { UserProfile } from '@core/types'
import { darkChromeCss } from '@core/theme/dark-chrome'
import type { Route } from '../routes'
import type { Workspace } from '../workspaces'
import { TitleBarChrome, type TitleBarProps } from './TitleBar'

interface ShellControls {
  declareTitleBar: (props: TitleBarProps) => void
  reportCoachLive: (live: boolean) => void
}
const ShellContext = createContext<ShellControls | null>(null)
export const useAppShell = (): ShellControls | null => useContext(ShellContext)

/** Chrome remains mounted while screen declarations change underneath it. */
export default function AppShell({ children, route, user, navigate, switchWorkspace }: {
  children?: ReactNode; route: Route; user: UserProfile | null
  navigate: (route: Route) => void; switchWorkspace: (section: Workspace) => void
}) {
  const [declaration, setDeclaration] = useState<TitleBarProps | null>(null)
  const [coachLive, setCoachLive] = useState(false)
  const declareTitleBar = useCallback((props: TitleBarProps) => setDeclaration(props), [])
  const controls = useMemo(() => ({ declareTitleBar, reportCoachLive: setCoachLive }), [declareTitleBar])
  // A newly loading screen has no declaration yet. Never show the old screen's actions.
  const current = declaration?.route === route ? declaration : {}
  return <ShellContext.Provider value={controls}>
    <style>{darkChromeCss}</style>
    <div className="app">
      <TitleBarChrome {...current} route={route} user={user} navigate={navigate} switchWorkspace={switchWorkspace} coachLive={coachLive} />
      {children}
    </div>
  </ShellContext.Provider>
}
