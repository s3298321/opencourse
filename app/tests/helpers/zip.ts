/**
 * A minimal ZIP writer for tests.
 *
 * Real archivers refuse to produce the archives that matter here - `..` in a
 * member name, an absolute path, a symlink pointing at /etc - so the tests
 * build them byte by byte instead. Stored (uncompressed) entries only, which
 * is all yauzl needs to read them back.
 */
import { writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipMember {
  name: string
  content?: string
  /** Raw bytes, for members that are not text (a PNG, a font). */
  bytes?: Buffer
  /** Written as a symlink entry whose body is the link target. */
  symlinkTo?: string
  /**
   * Lies about the uncompressed size - a zip bomb. Forces deflate, because
   * yauzl checks compressed against uncompressed size for stored entries.
   */
  declaredSize?: number
}

const FILE_MODE = 0o100644
const LINK_MODE = 0o120777

export function makeZip(path: string, members: ZipMember[]): string {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const member of members) {
    const isLink = member.symlinkTo !== undefined
    const raw = !isLink && member.bytes ? member.bytes : Buffer.from(isLink ? member.symlinkTo! : (member.content ?? ''), 'utf8')
    const bomb = member.declaredSize !== undefined
    const body = bomb ? deflateRawSync(raw) : raw
    const name = Buffer.from(member.name, 'utf8')
    const crc = crc32(raw)
    const size = member.declaredSize ?? raw.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(bomb ? 8 : 0, 8) // deflate, or stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(0x031e, 4) // made by unix, so external attrs carry the mode
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(bomb ? 8 : 0, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(((isLink ? LINK_MODE : FILE_MODE) << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  writeFileSync(path, Buffer.concat([...locals, directory, end]))
  return path
}
