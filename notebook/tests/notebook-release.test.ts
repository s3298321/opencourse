/**
 * OpenCourse Notebook updates from the same GitHub repository as OpenCourse.
 * A `v*` release is the other app and must never be installed here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_BUNDLE_NAME, backupPathFor, stagedPathFor } from '../src/main/update-install'
import { PUBLIC_LINKS } from '../src/core/links'
import { parseRelease, RELEASE_ASSET, RELEASE_TAG_PREFIX, selectRelease } from '../src/core/updates/release'

const DIGEST = 'a'.repeat(64)

function release(tag: string, asset = RELEASE_ASSET): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/s3298321/opencourse/releases/tag/${tag}`,
    assets: [{
      name: asset,
      size: 80_000_000,
      browser_download_url: `https://github.com/s3298321/opencourse/releases/download/${tag}/${asset}`,
      digest: `sha256:${DIGEST}`
    }]
  }
}

describe('notebook releases', () => {
  it('reads a notebook-v tag and ignores an OpenCourse release', () => {
    expect(parseRelease(release('notebook-v0.1.0'))).toMatchObject({ version: '0.1.0' })
    expect(parseRelease(release('v0.7.4'))).toBeNull()
    expect(parseRelease(release('server-v0.3.3'))).toBeNull()
    expect(parseRelease(release('notebook-v0.1.0', 'OpenCourse-mac-arm64.dmg'))).toBeNull()
  })

  it('picks the notebook release when an OpenCourse release is newer', () => {
    const chosen = selectRelease([
      release('v0.9.0', 'OpenCourse-mac-arm64.dmg'),
      release('notebook-v0.1.0'),
      release('notebook-v0.0.9')
    ])
    expect(chosen?.version).toBe('0.1.0')
    expect(chosen?.asset.url).toContain('notebook-v0.1.0')
  })

  it('names the bundle and the DMG the release workflow publishes', () => {
    const builder = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    const pattern = /dmg:[\s\S]*?artifactName:\s*(\S+)/.exec(builder)?.[1]
    expect(pattern!.replace('${arch}', 'arm64').replace('${ext}', 'dmg')).toBe(RELEASE_ASSET)
    expect(builder).toContain('productName: OpenCourse Notebook')
    expect(APP_BUNDLE_NAME).toBe('OpenCourse Notebook.app')
    expect(RELEASE_TAG_PREFIX).toBe('notebook-v')
    expect(PUBLIC_LINKS.download).toBe('https://opencourse.dev/notebook')
    expect(stagedPathFor('/Applications/OpenCourse Notebook.app', '0.1.0')).toBe('/Applications/.OpenCourseNotebook-0.1.0.app')
    expect(backupPathFor('/Applications/OpenCourse Notebook.app')).toBe('/Applications/.OpenCourseNotebook-previous.app')
    expect(stagedPathFor('/Applications/OpenCourse.app', '0.7.4')).not.toBe('/Applications/.OpenCourse-0.7.4.app')
  })
})
