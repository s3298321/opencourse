import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeAssetResolver, MAX_INLINE_BYTES } from '../src/main/assets'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'opencourse-assets-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(root, 'assets', 'huge.svg'), '<svg>' + 'x'.repeat(MAX_INLINE_BYTES) + '</svg>')
  writeFileSync(join(root, 'assets', 'photo.png'), 'not really a png')
})

describe('makeAssetResolver', () => {
  it('inlines small svgs, which the opencourse:// scheme cannot paint', () => {
    const url = makeAssetResolver(root, 'demo')('assets/cover.svg')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(url.split(',')[1], 'base64').toString()).toContain('<svg')
  })

  it('leaves other file types on the scheme', () => {
    expect(makeAssetResolver(root, 'demo')('assets/photo.png')).toBe('opencourse://demo/assets/photo.png')
  })

  it('does not inline an oversized svg', () => {
    expect(makeAssetResolver(root, 'demo')('assets/huge.svg')).toBe('opencourse://demo/assets/huge.svg')
  })

  it('does not inline something outside the course', () => {
    expect(makeAssetResolver(root, 'demo')('../secrets.svg')).toBe('opencourse://demo/../secrets.svg')
  })

  it('handles a missing file without throwing', () => {
    expect(makeAssetResolver(root, 'demo')('assets/nope.svg')).toBe('opencourse://demo/assets/nope.svg')
  })
})
