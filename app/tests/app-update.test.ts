/**
 * The app's own updates: what a release feed is believed about, which hosts a
 * download may be sent on to, and where this copy may replace itself. The feed
 * is someone else's JSON, so most of these are hostile.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOWNLOAD_PAGE, MAX_ASSET_BYTES, parseRelease, RELEASE_ASSET, RELEASE_REPO, releaseFeedUrl } from '@core/updates/release'
import { allowedUpdateUrl, CHECK_INTERVAL_MS, checkDue, installTarget, isNewer, notWritable } from '@core/updates/policy'

const DIGEST = 'a'.repeat(64)

function release(overrides: Record<string, unknown> = {}, asset: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/s3298321/opencourse/releases/tag/v0.2.0',
    body: 'What changed.',
    assets: [
      { name: 'latest-mac.yml', size: 400, browser_download_url: 'https://github.com/s3298321/opencourse/releases/download/v0.2.0/latest-mac.yml', digest: `sha256:${'b'.repeat(64)}` },
      {
        name: RELEASE_ASSET,
        size: 150_000_000,
        browser_download_url: `https://github.com/s3298321/opencourse/releases/download/v0.2.0/${RELEASE_ASSET}`,
        digest: `sha256:${DIGEST}`,
        ...asset
      }
    ],
    ...overrides
  }
}

describe('parseRelease', () => {
  it('reads the version, the page and the DMG with its digest', () => {
    expect(parseRelease(release())).toEqual({
      version: '0.2.0',
      notesUrl: 'https://github.com/s3298321/opencourse/releases/tag/v0.2.0',
      asset: { url: `https://github.com/s3298321/opencourse/releases/download/v0.2.0/${RELEASE_ASSET}`, size: 150_000_000, sha256: DIGEST }
    })
    expect(parseRelease(release({}, { digest: `sha256:${'A'.repeat(64)}` }))?.asset.sha256).toBe(DIGEST)
  })

  it('reads the release GitHub actually published (v0.1.0, trimmed to what is read)', () => {
    const published = {
      tag_name: 'v0.1.0',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/s3298321/opencourse/releases/tag/v0.1.0',
      assets: [
        { name: 'latest-mac.yml', size: 345, digest: 'sha256:9e0569c5fdfca4117250d4805f1339618a4eeea7636d556b6f0b389e8b2a8f75', browser_download_url: 'https://github.com/s3298321/opencourse/releases/download/v0.1.0/latest-mac.yml' },
        { name: 'OpenCourse-mac-arm64.dmg', size: 137791214, digest: 'sha256:e21b31d2322c3a85010ad413437ed59ca4c7824d67eeba5e7eb1fe3bfdb49598', browser_download_url: 'https://github.com/s3298321/opencourse/releases/download/v0.1.0/OpenCourse-mac-arm64.dmg' }
      ]
    }
    expect(parseRelease(published)).toEqual({
      version: '0.1.0',
      notesUrl: 'https://github.com/s3298321/opencourse/releases/tag/v0.1.0',
      asset: { url: published.assets[1]!.browser_download_url, size: 137791214, sha256: 'e21b31d2322c3a85010ad413437ed59ca4c7824d67eeba5e7eb1fe3bfdb49598' }
    })
    // Where GitHub sends that download (a 302, observed): an allowed hop.
    expect(allowedUpdateUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1408788733/c22edfb5-8172-4327-a487-1c3ad731ad77')).toBe(true)
  })

  it('refuses anything that is not a release this app can install', () => {
    const refused: Array<[string, unknown]> = [
      ['not an object', 'v0.2.0'],
      ['a draft', release({ draft: true })],
      ['a prerelease', release({ prerelease: true })],
      ['a tag without its v', release({ tag_name: '0.2.0' })],
      ['a two-part version', release({ tag_name: 'v1.2' })],
      ['a pre-release version', release({ tag_name: 'v1.2.0-beta.1' })],
      ['a server tag', release({ tag_name: 'server-v0.2.0' })],
      ['a page on another site', release({ html_url: 'https://evil.example/releases/tag/v0.2.0' })],
      ['a page of another repository', release({ html_url: 'https://github.com/someone/opencourse/releases/tag/v0.2.0' })],
      ['no assets', release({ assets: [] })],
      ['no digest', release({}, { digest: undefined })],
      ['a digest of another kind', release({}, { digest: `sha512:${DIGEST}` })],
      ['a short digest', release({}, { digest: 'sha256:abc' })],
      ['a download elsewhere', release({}, { browser_download_url: `https://evil.example/${RELEASE_ASSET}` })],
      ['a download over http', release({}, { browser_download_url: `http://github.com/x/${RELEASE_ASSET}` })],
      ['no size', release({}, { size: undefined })],
      ['a ten-gigabyte DMG', release({}, { size: 10 * 1024 ** 3 })],
      ['a fractional size', release({}, { size: 1.5 })]
    ]
    for (const [what, raw] of refused) expect(parseRelease(raw), what).toBeNull()
    expect(parseRelease(release({}, { size: MAX_ASSET_BYTES }))).not.toBeNull()
  })

  it('takes a test feed\'s page and file from its own host, and only then', () => {
    const local = release({ html_url: 'http://127.0.0.1:8123/releases/v0.2.0' }, { browser_download_url: `http://127.0.0.1:8123/${RELEASE_ASSET}` })
    expect(parseRelease(local)).toBeNull()
    expect(parseRelease(local, { feedOrigin: 'http://127.0.0.1:8123/' })?.asset.url).toBe(`http://127.0.0.1:8123/${RELEASE_ASSET}`)
    expect(parseRelease(release({ html_url: 'http://127.0.0.1:8123/x' }, { browser_download_url: `http://127.0.0.1:9999/${RELEASE_ASSET}` }), { feedOrigin: 'http://127.0.0.1:8123/' })).toBeNull()
  })
})

describe('update policy', () => {
  it('only offers a version that is strictly newer', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.1')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(false)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.2.0', 'junk')).toBe(false)
  })

  it('sends a request only to GitHub over HTTPS, and to this machine only for a test feed', () => {
    for (const ok of [
      'https://api.github.com/repos/s3298321/opencourse/releases/latest',
      'https://github.com/s3298321/opencourse/releases/download/v0.2.0/x.dmg',
      'https://objects.githubusercontent.com/github-production-release-asset/1',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1'
    ]) expect(allowedUpdateUrl(ok), ok).toBe(true)
    for (const no of [
      'http://github.com/x',
      'https://github.com.evil.example/x',
      'https://evil.example/x',
      'https://user:pass@github.com/x',
      'http://127.0.0.1:8123/x',
      'file:///etc/passwd',
      'not a url'
    ]) expect(allowedUpdateUrl(no), no).toBe(false)
    expect(allowedUpdateUrl('http://127.0.0.1:8123/x', { loopback: true })).toBe(true)
    expect(allowedUpdateUrl('http://localhost:8123/x', { loopback: true })).toBe(true)
    expect(allowedUpdateUrl('http://192.168.1.2:8123/x', { loopback: true })).toBe(false)
  })

  it('checks again only after the interval', () => {
    expect(checkDue(null, 0)).toBe(true)
    expect(checkDue(1000, 1000 + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(checkDue(1000, 1000 + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('replaces only a packaged app bundle that macOS is not running from a temporary copy', () => {
    expect(installTarget('/Applications/OpenCourse.app/Contents/MacOS/OpenCourse', true)).toEqual({ ok: true, bundle: '/Applications/OpenCourse.app' })
    expect(installTarget('/Users/me/Applications/OpenCourse 2.app/Contents/MacOS/OpenCourse', true)).toEqual({ ok: true, bundle: '/Users/me/Applications/OpenCourse 2.app' })
    expect(installTarget('/Applications/OpenCourse.app/Contents/MacOS/OpenCourse', false)).toEqual({ ok: false, reason: 'unpackaged' })
    expect(installTarget('/private/var/folders/x/AppTranslocation/ABC/d/OpenCourse.app/Contents/MacOS/OpenCourse', true)).toEqual({ ok: false, reason: 'translocated' })
    expect(installTarget('/usr/local/bin/electron', true)).toEqual({ ok: false, reason: 'not-bundle' })
    expect(notWritable('/Volumes/OpenCourse 0.1.0-arm64/OpenCourse.app')).toBe('mounted')
    expect(notWritable('/Applications/OpenCourse.app')).toBe('read-only')
  })
})

describe('the release the app looks for is the one the workflow publishes', () => {
  const root = join(__dirname, '..', '..')
  const builder = readFileSync(join(root, 'app', 'electron-builder.yml'), 'utf8')

  it('names the DMG electron-builder writes for arm64', () => {
    const pattern = /dmg:[\s\S]*?artifactName:\s*(\S+)/.exec(builder)?.[1]
    expect(pattern).toBeDefined()
    expect(pattern!.replace('${arch}', 'arm64').replace('${ext}', 'dmg')).toBe(RELEASE_ASSET)
  })

  it('asks the repository releases are published to, which the website also links', () => {
    expect(builder).toMatch(new RegExp(`owner:\\s*${RELEASE_REPO.owner}\\b`))
    expect(builder).toMatch(new RegExp(`repo:\\s*${RELEASE_REPO.repo}\\b`))
    const site = readFileSync(join(root, 'site', 'src', 'site.config.ts'), 'utf8')
    expect(site).toContain(`repo: '${RELEASE_REPO.owner}/${RELEASE_REPO.repo}'`)
    expect(site).toContain(`/releases/latest/download/${RELEASE_ASSET}`)
    expect(releaseFeedUrl()).toBe(`https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`)
    expect(DOWNLOAD_PAGE).toBe('https://opencourse.dev/download')
  })
})
