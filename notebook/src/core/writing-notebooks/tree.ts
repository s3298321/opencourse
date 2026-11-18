/**
 * Pure rules of the notebook page tree: path and name validation, and building
 * the visible tree from a directory listing plus the metadata page list.
 * No Electron, no filesystem — the disk half lives in main/writing-notebook-tree.ts.
 *
 * A page's file name is its title: `<title>.json` inside the tree. The page
 * keeps a UUID identity of its own (inside the file and the metadata page
 * list) so renames and moves never break references to it.
 */
import type { WritingTreeNode } from './types'

/** The tree root inside the notebook folder. Assets stay outside it, invisible. */
export const WRITING_TREE_DIR = 'pages'
export const MAX_WRITING_FOLDER_DEPTH = 32

/** The file name a page title maps to inside the tree. */
export function pageFileName(title: string): string { return `${title}.json` }

/** The page title a tree path carries: the file name without its .json extension. */
export function pageTitle(path: string): string {
  const name = treeName(path)
  return name.toLowerCase().endsWith('.json') ? name.slice(0, -5) : name
}

/** Validate a relative tree path ('' is the root). Throws with a renderer-ready message. */
export function treePath(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid folder path.')
  if (value === '') return ''
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw new Error('Invalid folder path.')
  const segments = value.split('/')
  if (segments.length > MAX_WRITING_FOLDER_DEPTH) throw new Error(`Folders can nest up to ${MAX_WRITING_FOLDER_DEPTH} levels.`)
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) throw new Error('Invalid folder path.')
  }
  return segments.join('/')
}

/** Validate a new folder name. Throws with a renderer-ready message. */
export function folderName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('Use a folder name between 1 and 200 characters.')
  const name = value.trim()
  if (/[\\/:*?"<>|]/.test(name) || /[\u0000-\u001f]/.test(name) || name.startsWith('.')) throw new Error('Folder names cannot contain \\ / : * ? " < > | or start with a dot.')
  return name
}

/** Validate a new name for a foreign file. Looser than folderName: ':' and friends are legal on disk, but the tree must still be able to show the result. */
export function fileName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) throw new Error('Use a file name between 1 and 255 characters.')
  const name = value.trim()
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name) || name.startsWith('.') || name.includes('.tmp') || name.endsWith('.deleted')) throw new Error('That file name cannot be used in a notebook.')
  return name
}

/**
 * Validate a page title. The title becomes the page's file name, so it has to
 * be usable as one: no path separators or control characters, no leading dot,
 * and nothing the tree scan would hide (.tmp, .deleted, overlong names).
 */
export function pageName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('Use a page name between 1 and 200 characters.')
  const name = value.trim()
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name) || name.startsWith('.')) throw new Error('A page name cannot contain \\ / or start with a dot.')
  fileName(pageFileName(name))
  return name
}

export function treeJoin(parent: string, name: string): string { return parent ? `${parent}/${name}` : name }
export function treeParent(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at) }
export function treeName(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? path : path.slice(at + 1) }
export function treeDepth(path: string): number { return path ? path.split('/').length : 0 }

/** One entry of a recursive tree listing; directories and regular files only. */
export interface WritingTreeEntry { path: string; directory: boolean }

/**
 * Build the visible tree. Folders sort alphabetically first, pages keep the
 * manual order of the metadata page list, foreign files sort alphabetically
 * last. A file is a page exactly when its path is a listed page's path; every
 * other file — including stray .json files — is foreign.
 */
export function buildWritingTree(entries: WritingTreeEntry[], pages: { id: string; path: string }[]): WritingTreeNode[] {
  const root: WritingTreeNode[] = []
  const folders = new Map<string, WritingTreeNode & { kind: 'folder' }>()
  const ensure = (path: string): WritingTreeNode & { kind: 'folder' } => {
    const existing = folders.get(path)
    if (existing) return existing
    const node: WritingTreeNode & { kind: 'folder' } = { kind: 'folder', name: treeName(path), path, children: [] }
    folders.set(path, node)
    const parent = treeParent(path)
    if (parent) ensure(parent).children.push(node)
    else root.push(node)
    return node
  }
  for (const entry of entries) if (entry.directory) ensure(entry.path)
  const order = new Map(pages.map((page, index) => [page.id, index]))
  const byPath = new Map(pages.map(page => [page.path, page]))
  for (const entry of entries) {
    if (entry.directory) continue
    const page = byPath.get(entry.path)
    const list = treeParent(entry.path) ? ensure(treeParent(entry.path)).children : root
    if (page) list.push({ kind: 'page', id: page.id, path: entry.path })
    else list.push({ kind: 'file', name: treeName(entry.path), path: entry.path })
  }
  const rank = (node: WritingTreeNode) => node.kind === 'folder' ? 0 : node.kind === 'page' ? 1 : 2
  const sort = (nodes: WritingTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      if (a.kind === 'page' && b.kind === 'page') return order.get(a.id)! - order.get(b.id)!
      const an = a.kind === 'page' ? pageTitle(a.path) : a.name, bn = b.kind === 'page' ? pageTitle(b.path) : b.name
      return an.localeCompare(bn)
    })
    for (const node of nodes) if (node.kind === 'folder') sort(node.children)
  }
  sort(root)
  return root
}

/** Every page node at or under a folder path ('' = the whole tree). */
export function pagesUnder(nodes: WritingTreeNode[], folder: string): { id: string; path: string }[] {
  const found: { id: string; path: string }[] = []
  const walk = (list: WritingTreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'page') { if (!folder || treeParent(node.path) === folder || node.path.startsWith(folder + '/')) found.push(node) }
      else if (node.kind === 'folder') walk(node.children)
    }
  }
  walk(nodes)
  return found
}

/** Locate one page node by id. */
export function findPageNode(nodes: WritingTreeNode[], pageId: string): { id: string; path: string } | undefined {
  for (const node of nodes) {
    if (node.kind === 'page' && node.id === pageId) return node
    if (node.kind === 'folder') { const found = findPageNode(node.children, pageId); if (found) return found }
  }
  return undefined
}

/** Locate one foreign-file node by its tree path. */
export function findFileNode(nodes: WritingTreeNode[], path: string): { kind: 'file'; name: string; path: string } | undefined {
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === path) return node
    if (node.kind === 'folder') { const found = findFileNode(node.children, path); if (found) return found }
  }
  return undefined
}

/** A copy of the tree with one page renamed — the page's file name carries the new title — for optimistic edits before the save lands. */
export function renamePageNode(nodes: WritingTreeNode[], pageId: string, title: string): WritingTreeNode[] {
  const file = pageFileName(title)
  return nodes.map(node => {
    if (node.kind === 'page') return node.id === pageId ? { ...node, path: treeJoin(treeParent(node.path), file) } : node
    if (node.kind === 'folder') return { ...node, children: renamePageNode(node.children, pageId, title) }
    return node
  })
}