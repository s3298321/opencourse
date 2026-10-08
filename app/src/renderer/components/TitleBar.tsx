import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { UserProfile } from '@core/types'
import Menu from './Menu'
import Brand from './Brand'
import UpdateButton from './UpdateButton'
import { screenOf, sectionOf, type Route } from '../routes'

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
export default function TitleBar({
  back,
  user,
  navigate,
  route,
  actions
}: {
  back?: { label: string; onClick: () => void }
  user?: UserProfile | null
  navigate?: (r: Route) => void
  /** The whole route, not just its half: Settings has to know where to go back to. */
  route?: Route
  /** Controls belonging to the screen itself, ahead of the chips every screen has. */
  actions?: ReactNode
}): JSX.Element {
  const section = route ? sectionOf(route) : null
  const controlsRef = useRef<HTMLDivElement>(null)
  const [controlsWidth, setControlsWidth] = useState(80)

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
    <div className="titlebar" style={{ '--titlebar-controls-width': `${controlsWidth}px` } as CSSProperties}>
      {back ? <div className="crumbs"><a onClick={back.onClick}>← {back.label}</a></div> : <Brand />}
      <div className="titlebar-right" ref={controlsRef}>
        <UpdateButton
          openSettings={navigate && route ? () => navigate({ name: 'settings', from: screenOf(route), section: 'updates' }) : undefined}
        />
        {actions}
        {navigate && section && (
          <div
            className="section-switch"
            data-at={section}
            role="radiogroup"
            aria-label="Which half of the app"
          >
            {/* The thumb is a sibling, not a background on the active button:
                one element that moves animates, two that swap colour do not. */}
            <span className="section-switch-thumb" aria-hidden="true" />
            <button
              data-section="courses"
              role="radio"
              aria-checked={section === 'courses'}
              onClick={() => navigate({ name: 'library' })}
            >
              Courses
            </button>
            <button
              data-section="coach"
              role="radio"
              aria-checked={section === 'coach'}
              onClick={() => navigate({ name: 'coach' })}
            >
              Coach
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
          ? [{ id: 'settings', label: 'Settings…', onSelect: () => navigate({ name: 'settings', from }) }]
          : []),
        ...(route.name !== 'logs'
          ? [{ id: 'logs', label: 'Logs', onSelect: () => navigate({ name: 'logs', from }) }]
          : []),
        { id: 'switch', label: 'Switch user', onSelect: () => navigate({ name: 'users' }) }
      ]}
    />
  )
}
