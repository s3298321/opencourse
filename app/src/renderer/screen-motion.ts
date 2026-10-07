import { useLayoutEffect } from 'react'
import type { Route } from './routes'

/** Animate navigation without remounting persistent projects, editors or chats. */
export function useScreenEntrance(route: Route): void {
  const identity = JSON.stringify(route)
  useLayoutEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return
    const animations: Animation[] = []
    let started = false
    const observer = new MutationObserver(() => start())
    const start = (): void => {
      if (started || preference.matches) return
      const body = document.querySelector<HTMLElement>('.app > .body, .project-screen:not([hidden]) > .body')
      const heading = body?.querySelector('h1')
      // Course, lesson and Coach detail screens first render a loading state.
      // Animate the ready page, rather than spending the entrance on that state.
      if (!body || !heading) return
      started = true
      observer.disconnect()
      // Keep the titlebar steady and fixed controls in their coordinate system.
      animations.push(body.animate([{ opacity: 0.15 }, { opacity: 1 }], {
        duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)'
      }))
      animations.push(heading.animate([
        { transform: 'translateY(12px)' }, { transform: 'translateY(0)' }
      ], { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }))
    }
    const app = document.querySelector('.app')
    if (app) observer.observe(app, { childList: true, subtree: true })
    start()
    const cancel = (): void => {
      observer.disconnect()
      animations.forEach((animation) => animation.cancel())
    }
    const onPreference = (): void => { if (preference.matches) cancel() }
    preference.addEventListener('change', onPreference)
    return () => { cancel(); preference.removeEventListener('change', onPreference) }
  }, [identity])
}
