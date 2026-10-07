import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CourseManifest } from '@core/types'
import { visitNodes } from '@core/course-document'
import { captureMotion, motionAllowed, playMotion, previewText, type MotionSnapshot } from './motion'

function changedOutline(before: CourseManifest, after: CourseManifest): Set<string> {
  const fields = (manifest: CourseManifest): Map<string, string> => {
    const result = new Map<string, string>()
    visitNodes(manifest, node => result.set(String(node.nodeId), JSON.stringify({ ...node, lessons: undefined, blocks: undefined, flashcards: undefined })))
    return result
  }
  const old = fields(before)
  return new Set([...fields(after)].filter(([id, fields]) => old.get(id) !== fields).map(([id]) => id))
}

export function useAuthoringMotion(manifest: CourseManifest | null, selected: string | null, mode: 'manual' | 'ai') {
  const previewRef = useRef<HTMLElement>(null), outlineRef = useRef<HTMLElement>(null)
  const pending = useRef<{ snapshot: MotionSnapshot; changed: Set<string>; selected: string | null } | null>(null)
  const clear = useRef<(() => void) | null>(null)
  const state = useRef({ mode, selected }); state.current = { mode, selected }
  const cancel = (): void => { clear.current?.(); clear.current = null }
  const prepare = (before: CourseManifest, after: CourseManifest, aiRunning: boolean): void => {
    cancel()
    if (!aiRunning || state.current.mode !== 'ai' || !motionAllowed() || !previewRef.current || !outlineRef.current) { pending.current = null; return }
    pending.current = { snapshot: pending.current?.snapshot ?? captureMotion(previewRef.current, outlineRef.current),
      changed: new Set([...(pending.current?.changed ?? []), ...changedOutline(before, after)]), selected: pending.current ? pending.current.selected : state.current.selected }
  }
  useLayoutEffect(() => {
    const update = pending.current; pending.current = null
    cancel()
    if (update && mode === 'ai' && motionAllowed() && previewRef.current && outlineRef.current) {
      // Start before the browser paints: a frame of the finished edit, then the
      // same edit hidden and swept in, reads as a flicker.
      const play = (): (() => void) => playMotion(update.snapshot, previewRef.current!, outlineRef.current!, update.changed, update.selected === selected)
      let stop = play()
      const text = previewText(previewRef.current)
      // Code-editor documents and local preview resets settle in passive
      // effects. If they changed the text, start again against the settled DOM;
      // nothing has moved yet, so the restart does not show.
      const frame = window.requestAnimationFrame(() => {
        if (state.current.mode !== mode || state.current.selected !== selected || !motionAllowed() || !previewRef.current || !outlineRef.current) { stop(); return }
        if (previewText(previewRef.current) !== text) { stop(); stop = play() }
      })
      clear.current = () => { window.cancelAnimationFrame(frame); stop() }
    }
  }, [manifest, selected, mode])
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const stop = (): void => { pending.current = null; cancel() }
    preference?.addEventListener('change', stop); window.addEventListener('resize', stop)
    return () => { preference?.removeEventListener('change', stop); window.removeEventListener('resize', stop); stop() }
  }, [])
  return { previewRef, outlineRef, prepare }
}
