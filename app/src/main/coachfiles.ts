/**
 * A coach project's workspace on disk.
 *
 * Two guards, the same pair the rest of the app uses: `assertSafeRelativePath`
 * decides what a path may look like, `isInside` decides where it may land. The
 * project directory itself is never supplied by a caller - it is derived from
 * the project id and the current user - so a bad path can only fail, never
 * redirect.
 *
 * Note what is missing: there is no writer reachable from the renderer. The
 * user can read, move and delete; only a live session's tool calls can create
 * or change a file. "Read-only in the app" is structural here, not a disabled
 * button.
 */
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isInside } from '../core/safepath'
import { assertSafeRelativePath, assertSafeSegment } from '../core/scaffold'
import {
  MAX_COACH_FILE_BYTES,
  MAX_FILES_PER_PROJECT,
  MAX_PROJECT_BYTES,
  MAX_TEXT_BYTES,
  MAX_TREE_DEPTH,
  MIRROR_FILE,
  SNIFF_BYTES,
  TRASH_DIR,
  classifyFile,
  isWritableExtension,
  shapeTree,
  type FlatEntry
} from '../core/coach/files'
import type { CoachFileNode, CoachMoveResult } from '../core/types'
import { workspaceDir } from './coach'

/** The one place a caller-supplied path becomes a real one. */
function resolveIn(projectId: string, rel: string): string {
  const dir = workspaceDir(projectId)
  assertSafeRelativePath(rel, 'coach file path')
  const target = join(dir, rel)
  if (!isInside(dir, target)) throw new Error('that path is outside the project')
  return target
}

/** Reads just enough of a file to tell text from bytes, without slurping it. */
function sniff(path: string, bytes: number): Uint8Array | null {
  if (bytes === 0) return new Uint8Array(0)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, bytes))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function listFiles(projectId: string): CoachFileNode[] {
  const root = workspaceDir(projectId)
  const entries: FlatEntry[] = []

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || entries.length >= MAX_FILES_PER_PROJECT) return
    let listing: Dirent[]
    try {
      listing = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing) {
      if (entries.length >= MAX_FILES_PER_PROJECT) return
      // The mirror is the app's bookkeeping, not one of the coach's notes.
      if (!prefix && entry.name === MIRROR_FILE) continue
      // A symlink is neither: following it would leave the project.
      if (!entry.isDirectory() && !entry.isFile()) continue

      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (entry.isDirectory()) {
        entries.push({ path, kind: 'dir', bytes: 0, modifiedAt: stat.mtime.toISOString() })
        walk(full, path, depth + 1)
      } else {
        entries.push({
          path,
          kind: classifyFile(entry.name, sniff(full, stat.size)),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString()
        })
      }
    }
  }

  walk(root, '', 1)
  return shapeTree(entries)
}

/** Only ever called for something already classified as text. */
export function readTextFile(projectId: string, rel: string): { content: string; bytes: number; truncated: boolean } {
  const path = resolveIn(projectId, rel)
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('that is not a file')
  const buffer = readFileSync(path)
  const truncated = buffer.length > MAX_TEXT_BYTES
  const slice = truncated ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer
  return {
    content: slice.toString('utf8') + (truncated ? '\n\n… truncated: the file is larger than this view shows.' : ''),
    bytes: stat.size,
    truncated
  }
}

function projectBytes(projectId: string): number {
  let total = 0
  const walk = (nodes: readonly CoachFileNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'dir') walk(node.children ?? [])
      else total += node.bytes
    }
  }
  walk(listFiles(projectId))
  return total
}

export type CoachWriteOutcome = { ok: true; bytes: number } | { ok: false; error: string }

/**
 * The only writer, and it is reachable only from a live session's tool call.
 *
 * Every refusal is returned rather than thrown: the caller is a language model,
 * and an error it can read is an error it can recover from. One that kills the
 * IPC handler just stops the conversation.
 */
export function writeWorkspaceFile(
  projectId: string,
  rel: string,
  content: string,
  mode: 'write' | 'append' = 'write'
): CoachWriteOutcome {
  let path: string
  try {
    path = resolveIn(projectId, rel)
  } catch {
    return {
      ok: false,
      error: 'invalid path: use only letters, digits, dot, dash and underscore in file names - no spaces and no accents'
    }
  }
  if (!isWritableExtension(rel)) {
    return { ok: false, error: 'unsupported file type: use .md, .txt, .json, .csv, .tsv, .yml, .yaml or .log' }
  }
  if (rel === MIRROR_FILE) return { ok: false, error: `${MIRROR_FILE} belongs to the app; pick another name` }

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const next = mode === 'append' ? existing + content : content
  const bytes = Buffer.byteLength(next, 'utf8')
  if (bytes > MAX_COACH_FILE_BYTES) {
    return { ok: false, error: `that file would be ${bytes} bytes; the limit is ${MAX_COACH_FILE_BYTES}` }
  }
  const added = bytes - Buffer.byteLength(existing, 'utf8')
  if (added > 0 && projectBytes(projectId) + added > MAX_PROJECT_BYTES) {
    return { ok: false, error: 'this project is full; delete something before writing more' }
  }

  // Atomic, like every other writer here: a half-written note is worse than none.
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, next)
  renameSync(tmp, path)
  return { ok: true, bytes }
}

function uniqueTarget(path: string): string {
  if (!existsSync(path)) return path
  const dir = dirname(path)
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 1000; n += 1) {
    const candidate = join(dir, `${stem}-${n}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('too many files with that name')
}

/**
 * Delete means trash. Recoverable by default, and visible in the tree, so a
 * coach or a mis-click cannot quietly destroy a term's worth of notes.
 */
export function trashFile(projectId: string, rel: string): CoachMoveResult {
  let path: string
  try {
    path = resolveIn(projectId, rel)
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message }
  }
  if (!existsSync(path)) return { status: 'missing' }
  if (rel === TRASH_DIR || rel.startsWith(`${TRASH_DIR}/`)) {
    return { status: 'invalid', message: 'that is already in the trash' }
  }

  const trash = join(workspaceDir(projectId), TRASH_DIR)
  mkdirSync(trash, { recursive: true })
  renameSync(path, uniqueTarget(join(trash, `${Date.now()}-${basename(path)}`)))
  return { status: 'ok' }
}

/** The hard delete, and only from inside the trash. */
export function purgeFile(projectId: string, rel: string): CoachMoveResult {
  let path: string
  try {
    path = resolveIn(projectId, rel)
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message }
  }
  if (!rel.startsWith(`${TRASH_DIR}/`) && rel !== TRASH_DIR) {
    return { status: 'invalid', message: 'only files in the trash can be deleted for good' }
  }
  if (!existsSync(path)) return { status: 'missing' }
  rmSync(path, { recursive: true, force: true })
  return { status: 'ok' }
}

/** Refuses to overwrite: a move that silently replaces something is a data loss bug. */
export function moveFile(projectId: string, fromRel: string, toRel: string): CoachMoveResult {
  let from: string
  let to: string
  try {
    from = resolveIn(projectId, fromRel)
    to = resolveIn(projectId, toRel)
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message }
  }
  if (!existsSync(from)) return { status: 'missing' }
  if (from === to) return { status: 'ok' }
  if (existsSync(to)) return { status: 'exists' }
  // Moving a directory inside itself detaches the whole subtree.
  if (isInside(from, to) && statSync(from).isDirectory()) {
    return { status: 'invalid', message: 'a folder cannot be moved inside itself' }
  }

  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
  return { status: 'ok' }
}

export function createFolder(projectId: string, parentRel: string, name: string): CoachMoveResult {
  let target: string
  try {
    assertSafeSegment(name, 'folder name')
    target = resolveIn(projectId, parentRel ? `${parentRel}/${name}` : name)
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message }
  }
  if (existsSync(target)) return { status: 'exists' }
  mkdirSync(target, { recursive: true })
  return { status: 'ok' }
}

/**
 * The project directory itself. Exported for `path:reveal` and for the smoke
 * harness, which has to stand in for a tool call it cannot make. Nothing that
 * takes a caller-supplied path should use this - use the module's own
 * functions, which go through `resolveIn`.
 */
export function workspaceFileHost(projectId: string): string {
  return workspaceDir(projectId)
}
