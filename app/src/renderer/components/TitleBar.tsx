import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { UserProfile } from '@core/types'
import { WHITE_THEME_ID } from '@core/theme/builtin-ids'
import Menu from './Menu'
import Brand from './Brand'
import UpdateButton from './UpdateButton'
import { screenOf, sectionOf, type Route } from '../routes'
import type { Workspace } from '../workspaces'
import { useScreenActive } from '../screen-activity'
import { useActiveTheme } from '../theme/ThemeProvider'
import { useAppShell } from './AppShell'

/**
 * The one strip every screen shares: where you are, and who you are. Its centre
 * holds one back link and nothing beside it - the way back out of a lesson; ⌘L
 * works too, but only if you already know it does. It takes a label rather than
 * markup so that a screen cannot grow a breadcrumb trail there again.
 *
 * `section` names the half of the app you are in. It used to be a single button
 * labelled with the *other* half, which meant the titlebar read "Coach" while
 * you were in courses - a destination wearing the clothes of a status. The
 * switch shows both halves and marks the one you are in, so it can be read
 * rather than decoded.
 *
 * The user chip opens a menu rather than jumping straight to the picker:
 * switching user is one of the things you might want from your own name, and
 * settings and the log are the others.
 *
 * A waiting update of the app comes first of all, on every screen including
 * the picker: it is about the app rather than the screen, and it is gone again
 * once there is nothing to update.
 */
export interface TitleBarProps {
  back?: { label: string; onClick: () => void }
  user?: UserProfile | null
  navigate?: (r: Route) => void
  route?: Route
  actions?: ReactNode
}

/** Screens declare their controls; only the active screen owns the shared bar. */
export default function TitleBar(props: TitleBarProps): JSX.Element | null {
  const shell = useAppShell()
  const active = useScreenActive()
  useLayoutEffect(() => {
    if (active) shell?.declareTitleBar(props)
  }, [active, shell, props.back, props.user, props.navigate, props.route, props.actions])
  return shell ? null : <TitleBarChrome {...props} />
}

export function TitleBarChrome({ back, user, navigate, route, actions, switchWorkspace, coachLive = false }: TitleBarProps & {
  switchWorkspace?: (section: Workspace) => void
  coachLive?: boolean
}): JSX.Element {
  const theme = useActiveTheme()
  const section = route ? sectionOf(route) : null
  const controlsRef = useRef<HTMLDivElement>(null)
  const switchRef = useRef<HTMLDivElement>(null)
  const [controlsWidth, setControlsWidth] = useState(80)

  useLayoutEffect(() => {
    const workspaceSwitch = switchRef.current
    if (!workspaceSwitch) return
    const measure = (): void => {
      const button = workspaceSwitch.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      if (!button) return
      const bounds = button.getBoundingClientRect()
      const switchBounds = workspaceSwitch.getBoundingClientRect()
      workspaceSwitch.style.setProperty('--section-thumb-x', `${bounds.left - switchBounds.left - 2}px`)
      workspaceSwitch.style.setProperty('--section-thumb-width', `${bounds.width}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspaceSwitch)
    workspaceSwitch.querySelectorAll('button').forEach(button => observer.observe(button))
    return () => observer.disconnect()
  }, [section, coachLive, navigate])

  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    const measure = (): void => setControlsWidth(Math.max(80, controls.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(controls)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="titlebar" data-dark-chrome={theme.id === WHITE_THEME_ID ? '' : undefined} data-builtin-theme={theme.id === null || theme.id === WHITE_THEME_ID ? '' : undefined} style={{ '--titlebar-controls-width': `${controlsWidth}px` } as CSSProperties}>
      {back ? <div className="crumbs"><a role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); back.onClick() } }} onClick={back.onClick}>← {back.label}</a></div> : <Brand />}
      <div className="titlebar-right" ref={controlsRef}>
        <UpdateButton
          openSettings={navigate && route ? () => navigate({ name: 'settings', from: screenOf(route), section: 'updates' }) : undefined}
        />
        {actions}
        {navigate && section && (
          <div
            className="section-switch"
            ref={switchRef}
            data-at={section}
            role="radiogroup"
            aria-label="Workspace"
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const sections: Workspace[] = ['courses', 'documents', 'coach']
              const current = sections.indexOf(section)
              const next = event.key === 'Home' ? sections[0]! : event.key === 'End' ? sections[2]! : sections[(current + (event.key === 'ArrowLeft' ? -1 : 1) + sections.length) % sections.length]!
              if (switchWorkspace) switchWorkspace(next)
              else navigate({ name: next === 'courses' ? 'library' : next === 'documents' ? 'documents' : 'coach' })
              const button = event.currentTarget.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)
              requestAnimationFrame(() => button?.focus())
            }}
          >
            {/* The thumb is a sibling, not a background on the active button:
                one element that moves animates, two that swap colour do not. */}
            <span className="section-switch-thumb" aria-hidden="true" />
            <button
              data-section="courses"
              role="radio"
              aria-checked={section === 'courses'}
              tabIndex={section === 'courses' ? 0 : -1}
              onClick={() => switchWorkspace ? switchWorkspace('courses') : navigate({ name: 'library' })}
            >
              Courses
            </button>
            <button
              data-section="documents"
              role="radio"
              aria-checked={section === 'documents'}
              tabIndex={section === 'documents' ? 0 : -1}
              onClick={() => switchWorkspace ? switchWorkspace('documents') : navigate({ name: 'documents' })}
            >
              Documents
            </button>
            <button
              data-section="coach"
              role="radio"
              aria-checked={section === 'coach'}
              aria-label={coachLive ? 'Coach (live)' : 'Coach'}
              title={coachLive ? 'Coach is live' : undefined}
              tabIndex={section === 'coach' ? 0 : -1}
              onClick={() => switchWorkspace ? switchWorkspace('coach') : navigate({ name: 'coach' })}
            >
              Coach
              {coachLive && <span className="live-dot coach-live-indicator" aria-hidden="true" />}
            </button>
          </div>
        )}
        {user && navigate && route && <UserMenu user={user} navigate={navigate} route={route} />}
      </div>
    </div>
  )
}

function UserMenu({
  user,
  navigate,
  route
}: {
  user: UserProfile
  navigate: (r: Route) => void
  route: Route
}): JSX.Element {
  // Settings and Logs remember where they were opened from, so closing one puts
  // you back in the lesson you were reading. Each is not offered while you are
  // on it, and going from one to the other hands the screen underneath along -
  // an overlay never opens on top of another.
  const from = screenOf(route)
  return (
    <Menu
      resetKey={route}
      className="user-chip"
      panelClassName="user-menu"
      label={
        <>
          <span className="avatar small" style={{ background: user.color }} />
          {user.name}
        </>
      }
      items={[
        ...(route.name !== 'settings'
          ? [{ id: 'settings', label: 'Settings', onSelect: () => navigate({ name: 'settings', from }) }]
          : []),
        ...(route.name !== 'logs'
          ? [{ id: 'logs', label: 'Logs', onSelect: () => navigate({ name: 'logs', from }) }]
          : []),
        { id: 'switch', label: 'Switch user', onSelect: () => navigate({ name: 'users' }) }
      ]}
    />
  )
}
