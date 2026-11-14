/**
 * A course's own version: MAJOR.MINOR.PATCH and nothing else.
 *
 * No pre-release tags and no build metadata, on purpose. A server compares
 * versions to decide whether a publish may go ahead ("only upwards") and an app
 * compares them to offer an update; both have to agree on the order, and the
 * order of `1.0.0-beta.2` against `1.0.0-rc.1` is the part of semver nobody
 * agrees on. Three integers sort one way. The same pattern is in
 * course-schema.json as `courseVersion`.
 */
export const VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** What a new course starts at, and what an archive from before 1.5 is taken to be. */
export const DEFAULT_COURSE_VERSION = '0.1.0'

export type Version = readonly [major: number, minor: number, patch: number]

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string') return null
  const match = VERSION_PATTERN.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function isVersion(text: unknown): text is string {
  return parseVersion(text) !== null
}

/** Negative when a < b, zero when equal, positive when a > b. Throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) throw new Error(`Not a course version: ${!x ? a : b}`)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** The highest of a list, or null for an empty one. */
export function maxVersion(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null)
}
