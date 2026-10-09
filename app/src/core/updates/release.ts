/**
 * Where a new version of the app comes from, and what the app will believe of
 * what that place says.
 *
 * Releases are GitHub releases of this repository: the same DMG the website's
 * download button serves, built and uploaded by .github/workflows/release.yml.
 * GitHub computes a SHA-256 of every asset at upload and reports it as the
 * asset's `digest`, which is what a download is checked against. The response
 * is someone else's JSON, so it is read like a server's: known fields only,
 * each checked, and anything off is "no release" rather than half a release.
 */
import { parseVersion } from '../catalog/semver'

export const RELEASE_REPO = { owner: 's3298321', repo: 'opencourse' } as const

/** The one asset an update downloads. Pinned to electron-builder.yml's dmg.artifactName by a test. */
export const RELEASE_ASSET = 'OpenCourse-mac-arm64.dmg'

/** Where to send someone whose copy cannot replace itself. */
export const DOWNLOAD_PAGE = 'https://opencourse.dev/download'

/** A DMG of the app is ~150 MB; anything near this is not one. */
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024

export function releaseFeedUrl(): string {
  return `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`
}

export interface Release {
  /** MAJOR.MINOR.PATCH, without the tag's `v`. */
  version: string
  /** The release's page, for "What's new". */
  notesUrl: string
  asset: { url: string; size: number; sha256: string }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `releases/latest` as a Release, or null when it is not one this app can
 * install. Drafts and prereleases never come from that endpoint, but a feed
 * that says so anyway is refused rather than trusted.
 *
 * `options.feedOrigin` is set only for a test feed on this machine
 * (OPENCOURSE_UPDATE_FEED): its release page and asset are on that host too.
 */
export function parseRelease(raw: unknown, options: { feedOrigin?: string } = {}): Release | null {
  if (!isObject(raw)) return null
  if (raw['draft'] === true || raw['prerelease'] === true) return null
  const tag = raw['tag_name']
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null
  const version = tag.slice(1)
  if (!parseVersion(version)) return null

  const pages = options.feedOrigin ?? `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/`
  const notesUrl = raw['html_url']
  if (typeof notesUrl !== 'string' || !notesUrl.startsWith(pages) || notesUrl.length > 500) return null

  const assets = Array.isArray(raw['assets']) ? raw['assets'] : []
  const asset = assets.find((entry) => isObject(entry) && entry['name'] === RELEASE_ASSET)
  if (!isObject(asset)) return null
  const url = asset['browser_download_url']
  const size = asset['size']
  const digest = asset['digest']
  if (typeof url !== 'string' || url.length > 1000) return null
  try {
    const parsed = new URL(url)
    if (options.feedOrigin ? parsed.origin !== new URL(options.feedOrigin).origin : parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null
  } catch {
    return null
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_BYTES) return null
  const sha256 = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1]?.toLowerCase() : undefined
  if (!sha256) return null
  return { version, notesUrl, asset: { url, size, sha256 } }
}
