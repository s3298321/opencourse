/**
 * What lives in a coach's workspace, and which of it the app will show.
 *
 * Pure: main reads the bytes and does the containment checks, this file decides
 * what they mean. Classification is here so the awkward cases - a .md full of
 * NUL bytes, a UTF-8 BOM, a file with no extension at all - are unit tests
 * rather than something you find out by clicking.
 */
import type { CoachFileNode } from '../types'

/** Where a deleted file goes. Not dotted: every existing path guard rejects those. */
export const TRASH_DIR = 'trash'

/** The coach's own project mirror. It is app bookkeeping, not one of its notes. */
export const MIRROR_FILE = 'project.json'

export const MAX_COACH_FILE_BYTES = 256 * 1024
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_FILES_PER_PROJECT = 500
export const MAX_PROJECT_BYTES = 32 * 1024 * 1024
export const MAX_TREE_DEPTH = 4

/** How many bytes main reads to decide whether a file is text. */
export const SNIFF_BYTES = 4096

/** What the coach may create. Anything else is something the app cannot render anyway. */
export const WRITABLE_EXTENSIONS = ['.md', '.txt', '.json', '.csv', '.tsv', '.yml', '.yaml', '.log'] as const

/** What the app will *show*. A superset: a file can arrive that the coach could not write. */
export const TEXT_EXTENSIONS = [
  ...WRITABLE_EXTENSIONS,
  '.markdown',
  '.text',
  '.ini',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.c',
  '.h',
  '.sql',
  '.sh'
] as const

/** Extensions worth deciding without a read, because sniffing them would mislead. */
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico', '.heic',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.dmg',
  '.ttf', '.otf', '.woff', '.woff2',
  '.sqlite', '.db', '.bin', '.so', '.dylib'
] as const

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension: ".gitignore" has none.
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function isWritableExtension(name: string): boolean {
  return (WRITABLE_EXTENSIONS as readonly string[]).includes(extensionOf(name))
}

/**
 * Text files can be read in the app; everything else is listed, moved and
 * deleted but never opened.
 *
 * `head` is the first few KB, or null when the caller did not read any - in
 * which case an unknown extension is treated as binary, because showing bytes
 * as text is the worse failure.
 */
export function classifyFile(name: string, head: Uint8Array | null): 'text' | 'binary' {
  const ext = extensionOf(name)
  if ((BINARY_EXTENSIONS as readonly string[]).includes(ext)) return 'binary'
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    // Trust the extension only as far as the bytes allow: a .md full of NULs
    // is not something to render.
    return head && hasNul(head) ? 'binary' : 'text'
  }
  if (!head) return 'binary'
  return hasNul(head) ? 'binary' : 'text'
}

function hasNul(head: Uint8Array): boolean {
  for (const byte of head) if (byte === 0) return true
  return false
}

/** A flat entry as main's walk produces it, before it becomes a tree. */
export interface FlatEntry {
  /** Relative to the project directory, forward-slashed, never empty. */
  path: string
  kind: 'dir' | 'text' | 'binary'
  bytes: number
  modifiedAt: string
}

/**
 * Folds a flat walk into the nested shape the tree renders and the prompt
 * lists. Directories sort first, then by name, so the order is stable between
 * renders and between sessions - and `trash/` sorts last whatever else is
 * there, because it is not part of the work.
 */
export function shapeTree(entries: readonly FlatEntry[]): CoachFileNode[] {
  const roots: CoachFileNode[] = []
  const byPath = new Map<string, CoachFileNode>()

  // Shallowest first, so a child never arrives before the directory holding it.
  const ordered = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)

  for (const entry of ordered) {
    const segments = entry.path.split('/')
    const name = segments[segments.length - 1] as string
    const node: CoachFileNode = {
      name,
      path: entry.path,
      kind: entry.kind,
      bytes: entry.bytes,
      modifiedAt: entry.modifiedAt,
      ...(entry.kind === 'dir' ? { children: [] } : {})
    }
    byPath.set(entry.path, node)

    const parent = segments.length > 1 ? byPath.get(segments.slice(0, -1).join('/')) : undefined
    if (parent?.children) parent.children.push(node)
    else if (segments.length === 1) roots.push(node)
    // An entry whose parent was dropped by a cap is dropped with it: a child
    // with no visible parent has nowhere to render.
  }

  const sort = (nodes: CoachFileNode[]): CoachFileNode[] => {
    nodes.sort((a, b) => {
      if (a.path === TRASH_DIR) return 1
      if (b.path === TRASH_DIR) return -1
      if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) if (node.children) sort(node.children)
    return nodes
  }
  return sort(roots)
}

/** Counts real files, not directories - what a project's size actually means. */
export function countFiles(nodes: readonly CoachFileNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === 'dir') n += countFiles(node.children ?? [])
    else n += 1
  }
  return n
}

/** Every directory in the tree, as move targets. '' is the project root. */
export function folderPaths(nodes: readonly CoachFileNode[]): string[] {
  const out: string[] = ['']
  const walk = (list: readonly CoachFileNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'dir') continue
      out.push(node.path)
      walk(node.children ?? [])
    }
  }
  walk(nodes)
  return out
}

/** A flat listing for the system prompt: the coach needs paths, not a drawing. */
export function describeTree(nodes: readonly CoachFileNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly CoachFileNode[]): void => {
    for (const node of list) {
      if (node.path === TRASH_DIR) continue
      if (node.kind === 'dir') walk(node.children ?? [])
      else out.push(`${node.path} (${node.bytes} bytes, changed ${node.modifiedAt})`)
    }
  }
  walk(nodes)
  return out
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}
