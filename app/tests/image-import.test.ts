// @vitest-environment node
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn(), decode: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ get: mocks.get }))
vi.mock('electron', () => ({ BrowserWindow: class {
  destroyed = false
  loadURL = vi.fn(async () => {})
  webContents = { executeJavaScript: mocks.decode }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
} }))
import { downloadImage, imageDownloadUrl, imageHeader, publicAddress, validateImage, MAX_IMAGE_BYTES, IMAGE_TIMEOUT_MS } from '../src/main/image-import'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const url = 'https://images.example.org/photo.png'
type Route = { status?: number; location?: string; body?: Buffer; size?: number; encoding?: string; hang?: boolean; interrupted?: boolean }
let routes: Route[]
beforeEach(() => {
  vi.useRealTimers(); routes = []
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  mocks.decode.mockReset().mockResolvedValue({ width: 1, height: 1 })
  mocks.get.mockReset().mockImplementation((_url, options, callback) => {
    const request = new EventEmitter()
    const route = routes.shift() ?? { body: png }
    options.signal.addEventListener('abort', () => request.emit('error', options.signal.reason), { once: true })
    queueMicrotask(() => {
      if (route.hang) return
      const response = Object.assign(new EventEmitter(), { statusCode: route.status ?? 200,
        headers: { location: route.location, 'content-length': route.size, 'content-encoding': route.encoding }, destroy: vi.fn() })
      callback(response)
      if (!response.destroy.mock.calls.length) {
        response.emit('data', route.body ?? png)
        response.emit(route.interrupted ? 'aborted' : 'end')
      }
    })
    return request
  })
})
describe('safe course image download', () => {
  it('uses the validated DNS address and sends no credentials or referrer', async () => {
    expect(await downloadImage(url, new AbortController().signal)).toEqual(png)
    const options = mocks.get.mock.calls[0][1]
    const callback = vi.fn(); options.lookup('images.example.org', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(options.agent).toBe(false)
    expect(options.headers).toEqual({ Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' })
  })
  it.each(['http://images.example.org/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://user:pass@images.example.org/a', 'https://images.example.org:8443/a', 'file:///tmp/a', 'data:image/png,x'])('rejects unsafe URL %s', raw => {
    expect(() => imageDownloadUrl(raw)).toThrow()
  })
  it.each(['127.0.0.1', '10.0.0.1', '100.64.1.2', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'])('rejects reserved DNS result %s', async address => {
    expect(publicAddress(address)).toBe(false)
    mocks.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }])
    await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('private or reserved')
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it('allows globally routable IPv6 and rejects mixed public/private DNS answers', async () => {
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])
    await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('private or reserved')
  })
  it('validates redirects including their DNS and caps redirect count', async () => {
    routes = [{ status: 302, location: 'https://cdn.example.org/a.png' }, { body: png }]
    expect(await downloadImage(url, new AbortController().signal)).toEqual(png)
    expect(mocks.lookup).toHaveBeenCalledTimes(2)
    routes = Array.from({ length: 4 }, () => ({ status: 302, location: '/next' }))
    await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('three redirects')
    routes = [{ status: 302, location: 'https://127.0.0.1/a' }]
    await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('public HTTPS')
    routes = [{ status: 302, location: 'https://private.example.org/a' }]
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '192.168.1.2', family: 4 }])
    await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('private or reserved')
  })
  it('bounds announced and actual bytes and rejects interrupted/error responses', async () => {
    for (const route of [{ size: MAX_IMAGE_BYTES + 1 }, { body: Buffer.alloc(MAX_IMAGE_BYTES + 1) }, { status: 404 }, { encoding: 'gzip' }, { interrupted: true }]) {
      routes = [route]
      await expect(downloadImage(url, new AbortController().signal)).rejects.toThrow()
    }
  })
  it('cancels during download and times out even during DNS lookup', async () => {
    routes = [{ hang: true }]
    const controller = new AbortController(), pending = downloadImage(url, controller.signal)
    const check = expect(pending).rejects.toThrow()
    await Promise.resolve(); controller.abort(); await check
    vi.useFakeTimers()
    mocks.lookup.mockImplementation(() => new Promise(() => {}))
    const timeout = expect(downloadImage(url, new AbortController().signal)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS); await timeout
    vi.useRealTimers()
  })
})
describe('image body validation', () => {
  it('checks dimensions before decoding and rejects truncated or undecodable files', async () => {
    expect(imageHeader(png)).toEqual({ extension: 'png', width: 1, height: 1 })
    await expect(validateImage(png, new AbortController().signal)).resolves.toBe('png')
    for (const data of [Buffer.from('<html>Not an image</html>'), Buffer.from('<svg/>'), png.subarray(0, 12)]) await expect(validateImage(data, new AbortController().signal)).rejects.toThrow()
    const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16); huge.writeUInt32BE(100_000, 20)
    mocks.decode.mockClear(); await expect(validateImage(huge, new AbortController().signal)).rejects.toThrow('40 megapixels'); expect(mocks.decode).not.toHaveBeenCalled()
    mocks.decode.mockRejectedValue(new Error('Invalid data'))
    await expect(validateImage(png, new AbortController().signal)).rejects.toThrow('could not be decoded')
  })
  it('does not wait indefinitely for a hung decoder on cancellation or timeout', async () => {
    mocks.decode.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const cancelled = expect(validateImage(png, controller.signal)).rejects.toThrow()
    await Promise.resolve(); controller.abort(); await cancelled
    vi.useFakeTimers()
    const timeout = expect(validateImage(png, new AbortController().signal)).rejects.toThrow('could not be decoded')
    await vi.advanceTimersByTimeAsync(5000); await timeout
    vi.useRealTimers()
  })
  it('reads JPEG, GIF and all three WebP dimension headers', () => {
    const gif = Buffer.from('47494638396102000300', 'hex')
    expect(imageHeader(gif)).toEqual({ extension: 'gif', width: 2, height: 3 })
    const jpg = Buffer.from('ffd8ffc00008080003000200', 'hex')
    expect(imageHeader(jpg)).toEqual({ extension: 'jpg', width: 2, height: 3 })
    for (const kind of ['VP8X', 'VP8 ', 'VP8L']) {
      const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write(kind, 12)
      if (kind === 'VP8X') { webp.writeUIntLE(1, 24, 3); webp.writeUIntLE(2, 27, 3) }
      if (kind === 'VP8 ') { Buffer.from([157, 1, 42]).copy(webp, 23); webp.writeUInt16LE(2, 26); webp.writeUInt16LE(3, 28) }
      if (kind === 'VP8L') { webp[20] = 0x2f; webp.writeUInt32LE(1 | (2 << 14), 21) }
      expect(imageHeader(webp)).toEqual({ extension: 'webp', width: 2, height: 3 })
    }
  })
})
