/**
 * Pure rules of the notebook page tree: path and name validation, and building
 * the visible tree from a directory listing plus the metadata page list.
 * No Electron, no filesystem — the disk half lives in main/writing-notebook-tree.ts.
 */
import type { WritingTreeNode } from './types'

/** The tree root inside the notebook folder. Assets stay outside it, invisible. */
export const WRITING_TREE_DIR = 'pages'
export const MAX_WRITING_FOLDER_DEPTH = 32

const PAGE_FILE = /^([0-9a-f-]{36})\.json$/i

/** The page id a tree file name carries, or null when the file is not a page file. */
export function pageFileId(name: string): string | null {
  return PAGE_FILE.exec(name)?.[1] ?? null
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

export function treeJoin(parent: string, name: string): string { return parent ? `${parent}/${name}` : name }
export function treeParent(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at) }
export function treeName(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? path : path.slice(at + 1) }
export function treeDepth(path: string): number { return path ? path.split('/').length : 0 }

/** One entry of a recursive tree listing; directories and regular files only. */
export interface WritingTreeEntry { path: string; directory: boolean }

/**
 * Build the visible tree. Folders sort alphabetically first, pages keep the
 * manual order of the metadata page list, foreign files sort alphabetically
 * last. A `<uuid>.json` file whose id is not a listed page is a foreign file.
 */
export function buildWritingTree(entries: WritingTreeEntry[], pages: { id: string; title: string }[]): WritingTreeNode[] {
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
  for (const entry of entries) {
    if (entry.directory) continue
    const name = treeName(entry.path), id = pageFileId(name)
    const page = id !== null && order.has(id) ? pages.find(p => p.id === id)! : undefined
    const list = treeParent(entry.path) ? ensure(treeParent(entry.path)).children : root
    if (page) list.push({ kind: 'page', id: page.id, title: page.title, path: entry.path })
    else list.push({ kind: 'file', name, path: entry.path })
  }
  const rank = (node: WritingTreeNode) => node.kind === 'folder' ? 0 : node.kind === 'page' ? 1 : 2
  const sort = (nodes: WritingTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      if (a.kind === 'page' && b.kind === 'page') return order.get(a.id)! - order.get(b.id)!
      const an = a.kind === 'page' ? a.title : a.name, bn = b.kind === 'page' ? b.title : b.name
      return an.localeCompare(bn)
    })
    for (const node of nodes) if (node.kind === 'folder') sort(node.children)
  }
  sort(root)
  return root
}

/** Every page node at or under a folder path ('' = the whole tree). */
export function pagesUnder(nodes: WritingTreeNode[], folder: string): { id: string; title: string; path: string }[] {
  const found: { id: string; title: string; path: string }[] = []
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
export function findPageNode(nodes: WritingTreeNode[], pageId: string): { id: string; title: string; path: string } | undefined {
  for (const node of nodes) {
    if (node.kind === 'page' && node.id === pageId) return node
    if (node.kind === 'folder') { const found = findPageNode(node.children, pageId); if (found) return found }
  }
  return undefined
}

/** A copy of the tree with one page's title changed, for optimistic edits before the save lands. */
export function retitlePageNode(nodes: WritingTreeNode[], pageId: string, title: string): WritingTreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'page') return node.id === pageId ? { ...node, title } : node
    if (node.kind === 'folder') return { ...node, children: retitlePageNode(node.children, pageId, title) }
    return node
  })
}