/**
 * Where a course in a library came from. No origin: a local course - created
 * here or imported from a ZIP, with app-local IDs. An origin: a server course,
 * whose course ID and element IDs are the server's (identity.ts).
 *
 * `server` is the normalized address (url.ts), not a connection id, so a
 * server removed from Settings and added again finds its courses again.
 */
import type { CourseStatus } from './api'
import { compareVersions } from './semver'

export interface CourseOrigin {
  kind: 'server'
  server: string
  /** The server's name when the course was added, for when it is no longer connected. */
  serverName: string
  /** The version installed. */
  version: string
  /** A publisher edits in place; a learner's edits become a local copy. */
  role: 'publisher' | 'learner'
  /** The username that published it. */
  publisher: string
  installedAt: string
  /** The document revision that matched the server's copy; a later one means local edits. */
  revision: number
}

/** What the Library offers for a server course. */
export type UpdateState =
  | { kind: 'current' }
  /** A newer version is current. */
  | { kind: 'update'; version: string }
  /** The author rolled back below what is installed. */
  | { kind: 'switch'; version: string }
  /** Unpublished, or every version deleted. */
  | { kind: 'unlisted' }
  /** The server is not connected, or could not be asked. */
  | { kind: 'disconnected'; reason: 'not-connected' | 'unreachable' }

export function updateState(installed: string, status: CourseStatus | undefined): UpdateState {
  if (!status || !status.listed || !status.currentVersion) return { kind: 'unlisted' }
  const order = compareVersions(status.currentVersion, installed)
  return order > 0 ? { kind: 'update', version: status.currentVersion } : order < 0 ? { kind: 'switch', version: status.currentVersion } : { kind: 'current' }
}
