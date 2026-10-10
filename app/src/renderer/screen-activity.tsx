import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

const Activity = createContext(true)
export const ScreenActivityProvider = Activity.Provider
export const useScreenActive = (): boolean => useContext(Activity)

/** Hide without unmounting, retaining scroll offsets and the last focused control. */
export function ScreenHost({ active, children, className = '' }: { active: boolean; children?: ReactNode; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const saved = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([])
  const focus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!active) return
    for (const entry of saved.current) {
      entry.element.scrollTop = entry.top
      entry.element.scrollLeft = entry.left
    }
    if (focus.current?.isConnected) focus.current.focus({ preventScroll: true })
    return () => {
      const node = host.current
      if (!node) return
      // Layout cleanup runs before React applies hidden to the old workspace.
      saved.current = [...node.querySelectorAll<HTMLElement>('*')].filter(el => el.scrollTop || el.scrollLeft || el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
        .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
      if (node.contains(document.activeElement)) focus.current = document.activeElement as HTMLElement
    }
  }, [active])
  return <Activity.Provider value={active}><div ref={host} onFocusCapture={event => { focus.current = event.target as HTMLElement }} className={`screen-host ${className}`} hidden={!active} inert={!active}>{children}</div></Activity.Provider>
}
