/** Download course images without giving model-controlled URLs access to the local network. */
import { lookup } from 'node:dns/promises'
import { get } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { BrowserWindow } from 'electron'
import { fetchableUrl } from '../core/sidechat/favicon'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const IMAGE_TIMEOUT_MS = 15_000
const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4')
blocked.addSubnet('2001::', 23, 'ipv6')
blocked.addSubnet('2001:db8::', 32, 'ipv6')
blocked.addSubnet('2002::', 16, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
export function publicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}
export function imageDownloadUrl(raw: string): URL {
  const url = fetchableUrl(raw)
  if (!url || raw.length > 2048 || (url.port && url.port !== '443')) throw new Error('Image downloads require a public HTTPS URL without credentials on port 443.')
  return url
}

/** The socket uses the vetted address, not a second DNS lookup (rebinding). */
export async function downloadImage(raw: string, signal: AbortSignal): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Image download timed out.')), IMAGE_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, controller.signal])
  try {
    let url = imageDownloadUrl(raw)
    for (let redirects = 0; redirects <= 3; redirects++) {
      combined.throwIfAborted()
      let onAbort = () => {}
      const addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(combined.reason)
          combined.addEventListener('abort', onAbort, { once: true })
        })
      ]).finally(() => combined.removeEventListener('abort', onAbort))
      combined.throwIfAborted()
      if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('Image host resolves to a private or reserved address.')
      const address = addresses[0]!
      const result = await new Promise<Buffer | URL>((resolve, reject) => {
        const request = get(url, {
          agent: false, signal: combined, family: address.family,
          headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' },
          // All DNS answers were checked. Pin the connection while retaining the original TLS hostname.
          lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
        }, response => {
          const status = response.statusCode ?? 0
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy()
            try { resolve(imageDownloadUrl(new URL(response.headers.location, url).href)) } catch (error) { reject(error) }
            return
          }
          if (status !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.destroy(); reject(new Error(`Image download failed (HTTP ${status}).`)); return
          }
          if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
            response.destroy(); reject(new Error('Image exceeds 20 MiB.')); return
          }
          const chunks: Buffer[] = []; let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > MAX_IMAGE_BYTES) { response.destroy(); reject(new Error('Image exceeds 20 MiB.')); return }
            chunks.push(chunk)
          })
          response.on('end', () => resolve(Buffer.concat(chunks)))
          response.on('error', reject)
          response.on('aborted', () => reject(new Error('Image download was interrupted.')))
        })
        request.on('error', reject)
      })
      if (Buffer.isBuffer(result)) return result
      url = result
    }
    throw new Error('Image download exceeded three redirects.')
  } finally { clearTimeout(timer) }
}

/** Read dimensions before decoding, to bound native decoder allocation. */
export function imageHeader(bytes: Buffer): { extension: string; width: number; height: number } {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MiB.')
  let extension = '', width = 0, height = 0
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    extension = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    extension = 'gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8)
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    extension = 'webp'
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3) }
    else if (chunk === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff }
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    extension = 'jpg'
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break }
      offset += length
    }
  }
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('Use a valid PNG, JPEG, WebP, or GIF image of at most 40 megapixels.')
  return { extension, width, height }
}
/** Chromium supports all four formats; nativeImage's buffer decoder only supports PNG/JPEG. */
export async function validateImage(bytes: Buffer, signal: AbortSignal): Promise<string> {
  const header = imageHeader(bytes)
  signal.throwIfAborted()
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  const destroy = () => { if (!window.isDestroyed()) window.destroy() }
  let rejectDecode: (error: unknown) => void = () => {}
  const stopped = new Promise<never>((_, reject) => { rejectDecode = reject })
  const abort = () => rejectDecode(signal.reason)
  const timer = setTimeout(() => rejectDecode(new Error('Image decoding timed out.')), 5_000)
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Only a fixed blank document and data image; neither scripts from the image nor network access are allowed.
    const decoded = (async () => {
      await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">`))
      const mime = header.extension === 'jpg' ? 'jpeg' : header.extension
      const dataUrl = `data:image/${mime};base64,${bytes.toString('base64')}`
      return await window.webContents.executeJavaScript(`(async () => { const image = new Image(); image.src = ${JSON.stringify(dataUrl)}; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; })()`)
    })()
    const size = await Promise.race([decoded, stopped])
    signal.throwIfAborted()
    // EXIF orientation can swap the displayed width and height.
    if (!(size.width === header.width && size.height === header.height) && !(size.width === header.height && size.height === header.width)) throw new Error('Image dimensions do not match.')
    return header.extension
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('Image contents could not be decoded.', { cause: error })
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); destroy() }
}
