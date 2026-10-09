/**
 * The rules an update follows, with nothing to do with Electron or the disk so
 * they are plain unit tests: which version is newer, which hosts a request may
 * be sent on to, when the next check is due, and whether this copy of the app
 * is somewhere it can replace itself.
 */
import { compareVersions, parseVersion } from '../catalog/semver'
import { isLoopbackHost } from '../catalog/url'

/** How often an automatic check runs, when they are turned on. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function isNewer(current: string, candidate: string): boolean {
  if (!parseVersion(current) || !parseVersion(candidate)) return false
  return compareVersions(candidate, current) > 0
}

/**
 * GitHub answers a release asset with a redirect to its storage host, so a
 * download follows redirects - by hand, each hop checked here. Nothing but
 * HTTPS to these hosts; plain HTTP only to this machine, and only while a test
 * feed is in use, so a redirect cannot quietly aim a real download at a port on
 * the learner's own Mac.
 */
const UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

export function allowedUpdateUrl(raw: string, options: { loopback?: boolean } = {}): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (options.loopback && url.protocol === 'http:' && isLoopbackHost(url.hostname)) return true
  return url.protocol === 'https:' && UPDATE_HOSTS.has(url.hostname.toLowerCase())
}

export function checkDue(lastCheckAt: number | null, now: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= CHECK_INTERVAL_MS
}

export type NotInstallable = 'unpackaged' | 'mounted' | 'translocated' | 'not-bundle' | 'read-only'

export type InstallTarget = { ok: true; bundle: string } | { ok: false; reason: NotInstallable }

/**
 * The .app this process runs from, if it is one an update may replace.
 *
 * Not App Translocation's randomised read-only copy, which is where macOS runs
 * a quarantined app opened where it was downloaded; moving the app to
 * Applications fixes that, and the UI says so. Whether the place is writable
 * is the disk's question, asked by main - see notWritable.
 */
export function installTarget(exePath: string, packaged: boolean): InstallTarget {
  if (!packaged) return { ok: false, reason: 'unpackaged' }
  const match = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)
  if (!match) return { ok: false, reason: 'not-bundle' }
  const bundle = match[1]!
  if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated' }
  return { ok: true, bundle }
}

/** Why a bundle main found it cannot write to cannot update: its own disk image, or just not writable. */
export function notWritable(bundle: string): NotInstallable {
  return bundle.startsWith('/Volumes/') ? 'mounted' : 'read-only'
}

/** What to tell someone whose copy cannot update itself in place. */
export function installTargetMessage(reason: NotInstallable): string {
  switch (reason) {
    case 'unpackaged': return 'This is a development build, which does not update itself.'
    case 'mounted': return 'OpenCourse is running from its disk image. Move it to Applications to update it from here.'
    case 'translocated': return 'macOS is running OpenCourse from a temporary copy. Move it to Applications and open it from there to update it from here.'
    case 'read-only': return 'OpenCourse cannot replace itself where it is installed. Download the new version instead.'
    case 'not-bundle': return 'OpenCourse is not running from an app bundle, so it cannot replace itself.'
  }
}
