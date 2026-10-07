/**
 * Reading a theme directory: which files it holds, what each really is, and
 * its theme.json normalized against them.
 *
 * No Electron imports, like unzip.ts, so the tests read the same directories
 * the app does - docs/default-theme among them.
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { extensionOf } from '../core/import'
import { describeAsset, type AssetIndex, type ThemeAsset } from '../core/theme/assets'
import { normalizeTheme } from '../core/theme/normalize'
import type { Theme, ThemeNote } from '../core/theme/types'

/** Enough of any image header to find its size, and of any font to know it. */
const HEAD_BYTES = 64 * 1024

function head(file: string): Uint8Array {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = lstatSync(full)
    // A symlink never arrives through import (the archive policy refuses
    // them); one found here was put there by hand and is not followed.
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) walk(root, full, out)
    else if (stat.isFile()) out.push(relative(root, full).split(sep).join('/'))
  }
}

/** Every picture and font in the directory, by its path; or the first file that lies about itself. */
export function indexThemeDirectory(dir: string): { assets: AssetIndex } | { error: string } {
  const files: string[] = []
  walk(dir, dir, files)
  const assets = new Map<string, ThemeAsset>()
  for (const path of files) {
    const described = describeAsset(path, extensionOf(path), head(join(dir, path)))
    if (!described) continue
    if ('error' in described) return { error: described.error }
    assets.set(path, described)
  }
  return { assets }
}

export interface ThemeDirectory {
  theme: Theme
  notes: ThemeNote[]
  assets: AssetIndex
}

export function readThemeDirectory(dir: string): ThemeDirectory | { error: string } {
  const indexed = indexThemeDirectory(dir)
  if ('error' in indexed) return indexed
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'))
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { error: missing ? 'There is no theme.json in the theme.' : `theme.json is not valid JSON: ${(err as Error).message}` }
  }
  const normalized = normalizeTheme(raw, indexed.assets)
  if ('error' in normalized) return normalized
  return { ...normalized, assets: indexed.assets }
}
