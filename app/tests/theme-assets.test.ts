/**
 * What a theme file is, judged by its bytes - and the one thing the app does
 * to a theme's pixels, fading a grain texture to the strength a surface asks for.
 */
import { describe, expect, it } from 'vitest'
import { describeAsset, imageSize, MAX_IMAGE_SIDE, scaleAlpha, sniffFont } from '@core/theme/assets'

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

function png(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_1x1)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe('theme files', () => {
  it('knows fonts by their signatures, and refuses collections', () => {
    expect(sniffFont(Buffer.from('wOF2rest'))).toBe('font/woff2')
    expect(sniffFont(Buffer.from('wOFFrest'))).toBe('font/woff')
    expect(sniffFont(Buffer.from('OTTOrest'))).toBe('font/otf')
    expect(sniffFont(Buffer.from([0, 1, 0, 0, 9]))).toBe('font/ttf')
    expect(sniffFont(Buffer.from('ttcfrest'))).toBeNull()
    expect(sniffFont(Buffer.from('<svg>'))).toBeNull()
  })

  it('reads picture sizes from their headers', () => {
    expect(imageSize(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 })
    expect(imageSize(Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1'), 'image/gif')).toEqual({ width: 800, height: 600 })
    // SOI, an APP0 segment, then SOF0 with height 300 and width 400.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0])
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 400, height: 300 })
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0); vp8x.write('WEBP', 8); vp8x.write('VP8X', 12)
    vp8x.writeUIntLE(1023, 24, 3); vp8x.writeUIntLE(767, 27, 3)
    expect(imageSize(vp8x, 'image/webp')).toEqual({ width: 1024, height: 768 })
    expect(imageSize(Buffer.from('<svg/>'), 'image/svg+xml')).toBeNull()
  })

  it('refuses a picture that is not what its name says, or bigger than any screen', () => {
    expect(describeAsset('a.png', '.png', Buffer.from('<html>'))).toEqual({ error: 'a.png is not the image its name says it is' })
    expect(describeAsset('a.jpg', '.jpg', PNG_1x1)).toEqual({ error: 'a.jpg is not the image its name says it is' })
    expect(describeAsset('big.png', '.png', png(MAX_IMAGE_SIDE + 1, 10))).toMatchObject({ error: expect.stringMatching(/at most 8192/) })
    expect(describeAsset('ok.png', '.png', png(64, 64))).toEqual({ kind: 'image', mime: 'image/png', width: 64, height: 64 })
    expect(describeAsset('notes.txt', '.txt', Buffer.from('hi'))).toBeNull()
  })

  it('fades or strengthens a texture by its alpha alone, within the format\'s range', () => {
    const pixels = (): Uint8ClampedArray => new Uint8ClampedArray([100, 50, 20, 200, 9, 9, 9, 0, 255, 255, 255, 30])
    const half = pixels(); scaleAlpha(half, 0.5)
    expect([...half]).toEqual([100, 50, 20, 100, 9, 9, 9, 0, 255, 255, 255, 15])
    const strong = pixels(); scaleAlpha(strong, 2)
    expect([...strong]).toEqual([100, 50, 20, 255, 9, 9, 9, 0, 255, 255, 255, 60])
    const capped = pixels(); scaleAlpha(capped, 50)
    expect(capped[11]).toBe(100)
  })
})
