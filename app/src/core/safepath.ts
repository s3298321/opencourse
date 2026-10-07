/**
 * Path containment. The zip-slip guard from apps/courses/ingest.py, kept for
 * the opencourse:// handler: a request must never escape its course directory.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** Returns the real file path inside `root`, or null if it escapes or is not a file. */
export function resolveInside(root: string, relPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const candidate = resolve(join(root, decoded))
  if (!existsSync(root) || !existsSync(candidate)) return null

  const realRoot = realpathSync(root)
  const real = realpathSync(candidate)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
  if (!statSync(real).isFile()) return null
  return real
}

/**
 * Directory-safe containment. `resolveInside` deliberately only accepts files
 * (it serves the opencourse:// handler), but the terminal has to be pointed at a
 * directory that may not exist yet. Resolves symlinks as far up the chain as
 * currently exists, so a symlinked ancestor cannot smuggle the path out.
 */
export function isInside(root: string, candidate: string): boolean {
  if (!root || candidate.includes('\0')) return false

  let real = resolve(candidate)
  const tail: string[] = []
  while (!existsSync(real)) {
    const parent = dirname(real)
    if (parent === real) return false
    tail.unshift(real.slice(parent.length + 1))
    real = parent
  }

  try {
    const realRoot = realpathSync(root)
    const resolved = resolve(realpathSync(real), ...tail)
    return resolved === realRoot || resolved.startsWith(realRoot + sep)
  } catch {
    return false
  }
}
