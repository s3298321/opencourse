/**
 * Unpacking a course archive.
 *
 * Deliberately free of Electron imports: this is the one place the app writes
 * files it did not author, so it has to be testable against real archives -
 * zip slip, symlinks, disallowed types and all.
 */
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { classifyArchiveEntry, COURSE_POLICY, stripCommonRoot, type ArchivePolicy } from '../core/import'
import { resolveInside } from '../core/safepath'

/** yauzl's high bit of the external attributes carries the unix mode. */
function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
}

function openArchive(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error('could not read the archive'))
      else resolve(zipfile)
    })
  })
}

function readEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = []
    zip.on('entry', (entry: Entry) => {
      entries.push(entry)
      zip.readEntry()
    })
    zip.on('end', () => resolve(entries))
    zip.on('error', reject)
    zip.readEntry()
  })
}

function extractEntry(zip: ZipFile, entry: Entry, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error(`could not read ${entry.fileName}`))
      mkdirSync(dirname(target), { recursive: true })
      pipeline(stream, createWriteStream(target)).then(resolve, reject)
    })
  })
}

/**
 * Unpacks into `staging`, refusing anything the policy does not like and then
 * checking containment again with resolveInside - two independent guards,
 * because this is where the app writes files it did not author. Courses are
 * the default; a theme archive passes its own, narrower policy.
 */
export async function extractArchive(zipPath: string, staging: string, policy: ArchivePolicy = COURSE_POLICY): Promise<{ error?: string }> {
  let zip: ZipFile
  try {
    zip = await openArchive(zipPath)
  } catch (err) {
    return { error: `could not read the archive: ${(err as Error).message}` }
  }

  try {
    const entries = await readEntries(zip)
    if (entries.length > policy.limits.members) {
      return { error: `the archive has more than ${policy.limits.members} files` }
    }
    // yauzl checks each member's real size against the size it declares, so the
    // declared total is a real bound on what unpacking can write.
    const unpacked = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    if (policy.limits.unpackedBytes !== undefined && unpacked > policy.limits.unpackedBytes) {
      return { error: `the archive unpacks to more than ${policy.limits.unpackedBytes / 1024 / 1024} MB` }
    }

    const root = stripCommonRoot(entries.map((e) => e.fileName))
    let written = 0

    for (const entry of entries) {
      const verdict = classifyArchiveEntry(entry.fileName, {
        isSymlink: isSymlink(entry),
        size: entry.uncompressedSize
      }, policy)
      if (verdict.kind === 'skip') continue
      if (verdict.kind === 'reject') return { error: verdict.reason }

      const relative = root ? verdict.path.slice(root.length + 1) : verdict.path
      if (!relative) continue

      // The policy has already refused every way a name can point outside,
      // and staging is ours alone with no symlinks in it, so the write is safe
      // to make - then resolveInside confirms where it actually landed.
      const target = join(staging, relative)
      await extractEntry(zip, entry, target)
      if (!resolveInside(staging, relative)) {
        rmSync(target, { force: true })
        return { error: `path escapes the archive: ${entry.fileName}` }
      }
      written += 1
    }

    if (written === 0) return { error: 'the archive is empty' }
    return {}
  } catch (err) {
    // yauzl validates member names itself and refuses `..` and absolute paths
    // before the policy ever sees them. Same verdict either way, so report
    // it the same way instead of letting it escape as a thrown error.
    return { error: (err as Error).message }
  } finally {
    zip.close()
  }
}

