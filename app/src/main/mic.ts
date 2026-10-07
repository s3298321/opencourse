/**
 * Whether a microphone request should be granted right now.
 *
 * Electron's default permission handler grants media to any renderer that asks.
 * The microphone is the one capability this app genuinely needs and the one it
 * would be worst to leak, so the grant is narrowed twice: the permission
 * handlers in index.ts allow audio only, and only while this flag is set - which
 * happens in `coach:startSession` and is cleared the moment the session ends.
 *
 * A module-level flag rather than a parameter because the permission handlers
 * are installed once, at startup, long before any session exists.
 */
let live = 0

export function wantsMic(): boolean {
  return live > 0
}

/** Sessions can overlap in principle, so count rather than toggle. */
export function holdMic(): () => void {
  live += 1
  let released = false
  return () => {
    if (released) return
    released = true
    live = Math.max(0, live - 1)
  }
}
