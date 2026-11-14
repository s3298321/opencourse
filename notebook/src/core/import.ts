/**
 * What a course archive is allowed to contain.
 *
 * Pure policy, so the interesting cases - zip slip, symlinks, stray macOS
 * metadata - are unit-testable without touching a real archive. The extraction
 * itself is src/main/import.ts, which runs every member through here and then
 * through resolveInside() as an independent second guard.
 */

/** Mirrors the table in docs/course-format.md and the MIME map in main/protocol.ts. */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.json',
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.map',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf'
])

/**
 * Generous enough for a course with video, small enough that a hostile archive
 * cannot fill the disk before the first check fires.
 */
export const LIMITS = {
  archiveBytes: 200 * 1024 * 1024,
  memberBytes: 100 * 1024 * 1024,
  members: 5_000,
  /** Everything unpacked together. An archive from a server is someone else's file too. */
  unpackedBytes: 1024 * 1024 * 1024
} as const

/**
 * What one kind of archive may hold. Courses and themes share every structural
 * guard below - zip slip, symlinks, absolute paths, macOS litter - and differ
 * only in which file types they accept and how big they may be.
 */
export interface ArchivePolicy {
  extensions: ReadonlySet<string>
  limits: { archiveBytes: number; memberBytes: number; members: number; unpackedBytes?: number }
}

export const COURSE_POLICY: ArchivePolicy = { extensions: ALLOWED_EXTENSIONS, limits: LIMITS }

export type EntryVerdict =
  | { kind: 'file'; path: string }
  | { kind: 'skip' }
  | { kind: 'reject'; reason: string }

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * macOS puts its own bookkeeping in every zip made by Finder. None of it is
 * course content, and none of it should be an error either.
 */
function isMacMetadata(path: string): boolean {
  if (path === '.DS_Store' || path.startsWith('__MACOSX/')) return true
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base === '.DS_Store' || base.startsWith('._')
}

export function classifyEntry(name: string, meta: { isSymlink: boolean; size: number }): EntryVerdict {
  return classifyArchiveEntry(name, meta, COURSE_POLICY)
}

export function classifyArchiveEntry(name: string, meta: { isSymlink: boolean; size: number }, policy: ArchivePolicy): EntryVerdict {
  if (name.includes('\0')) return { kind: 'reject', reason: 'entry name contains a null byte' }
  if (name.endsWith('/')) return { kind: 'skip' }
  if (isMacMetadata(name)) return { kind: 'skip' }

  if (!name) return { kind: 'reject', reason: 'empty entry name' }
  if (name.includes('\\')) return { kind: 'reject', reason: `backslash in path: ${name}` }
  if (name.startsWith('/')) return { kind: 'reject', reason: `absolute path: ${name}` }
  if (/^[A-Za-z]:/.test(name)) return { kind: 'reject', reason: `absolute path: ${name}` }
  if (name.startsWith('~')) return { kind: 'reject', reason: `home-relative path: ${name}` }

  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) {
    return { kind: 'reject', reason: `path escapes the archive: ${name}` }
  }
  if (segments.some((segment) => segment === '.' || segment === '')) {
    return { kind: 'reject', reason: `malformed path: ${name}` }
  }

  // A symlink can point anywhere, including outside the course directory, and
  // the opencourse:// handler resolves real paths - so they never get written.
  if (meta.isSymlink) return { kind: 'reject', reason: `symlink: ${name}` }

  if (meta.size > policy.limits.memberBytes) {
    return { kind: 'reject', reason: `${name} is larger than ${policy.limits.memberBytes / 1024 / 1024} MB` }
  }

  const ext = extensionOf(name)
  if (!policy.extensions.has(ext)) {
    return { kind: 'reject', reason: `file type not allowed: ${name}` }
  }

  return { kind: 'file', path: name }
}

/**
 * Finder's "Compress" wraps the folder, so an author who zips `my-course/`
 * gets `my-course/course.json` rather than `course.json`. Returns the single
 * shared top-level directory to strip, or null when the entries already sit at
 * the archive root.
 */
export function stripCommonRoot(names: string[]): string | null {
  const paths = names.filter((name) => !name.endsWith('/') && !isMacMetadata(name))
  if (paths.length === 0) return null

  const first = paths[0]!.split('/')
  if (first.length < 2) return null
  const root = first[0]!
  return paths.every((name) => name.startsWith(`${root}/`)) ? root : null
}
