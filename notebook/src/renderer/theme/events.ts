/**
 * "A theme has just been applied": the stylesheet is in, its fonts have loaded,
 * and computed values read now are the new ones. Things that copy tokens out of
 * CSS into JavaScript (the editor, the terminal) listen for this rather than
 * for the IPC event, which fires before any of that is true.
 */
const target = new EventTarget()

export function announceThemeApplied(): void {
  target.dispatchEvent(new Event('applied'))
}

export function onThemeApplied(listener: () => void): () => void {
  target.addEventListener('applied', listener)
  return () => target.removeEventListener('applied', listener)
}
