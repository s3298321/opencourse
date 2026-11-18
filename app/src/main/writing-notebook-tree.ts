/**
 * Filesystem half of the notebook page tree. The hierarchy is real directories
 * under `<notebook>/pages`; assets stay outside it. Caller-provided paths are
 * validated in core (no '..', no absolute paths, no dot segments) and checked
 * against symlinks here before any operation touches them.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_WRITING_FOLDER_DEPTH, WRITING_TREE_DIR, treePath, type WritingTreeEntry } from '../core/writing-notebooks/tree'
import { writingNotebookDirectory } from './writing-notebook-locations'

export function writingTreeRoot(id: string): string { return join(writingNotebookDirectory(id), WRITING_TREE_DIR) }

const isSymlink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

/** Recursive listing. Symlinks, dotfiles and transient write files never enter the tree. */
export function scanWritingTree(id: string): WritingTreeEntry[] {
  const root = writingTreeRoot(id)
  const entries: WritingTreeEntry[] = []
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > MAX_WRITING_FOLDER_DEPTH) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      if (entry.name.includes('.tmp') || entry.name.endsWith('.deleted')) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { entries.push({ path, directory: true }); walk(join(directory, entry.name), path, depth + 1) }
      else if (entry.isFile()) entries.push({ path, directory: false })
    }
  }
  if (existsSync(root) && !isSymlink(root)) walk(root, '', 1)
  return entries
}

/** Resolve a relative tree path to an absolute one, refusing symlinked ancestors. '' is the root. */
export function resolveWritingTreePath(id: string, path: string): string {
  const relative = treePath(path)
  const root = writingTreeRoot(id)
  if (isSymlink(root)) throw new Error('The notebook folder is unavailable.')
  let current = root
  for (const segment of relative ? relative.split('/') : []) {
    current = join(current, segment)
    if (isSymlink(current)) throw new Error('Symbolic links are not supported in the notebook tree.')
  }
  return current
}

/**
 * A regular file's absolute path inside the page tree, for the asset protocol
 * to serve (images and videos of the file viewer). Caller-provided paths are
 * validated by resolveWritingTreePath, which also refuses symlinked segments;
 * the id shape matches the asset rule above. Null when anything is off.
 */
export function writingNotebookTreeFile(id: string, path: string): string | null {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const file = resolveWritingTreePath(id, path)
    return lstatSync(file).isFile() ? file : null
  } catch { return null }
}

/**
 * Adopt flat pre-tree page files into the tree root. Idempotent and safe to
 * re-run after a crash: each rename is atomic, and a file already present in
 * the tree wins over its flat duplicate.
 */
export function migrateWritingTree(id: string, pageIds: string[]): void {
  const directory = writingNotebookDirectory(id), root = join(directory, WRITING_TREE_DIR)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const wanted = new Set(pageIds)
  // One listing instead of a stat per page: reads happen on every save.
  const flat = readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name) && wanted.has(name.slice(0, -5)))
  for (const name of flat) {
    const file = join(directory, name), target = join(root, name)
    if (existsSync(target)) rmSync(file, { force: true })
    else renameSync(file, target)
  }
}