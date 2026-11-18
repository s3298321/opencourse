/**
 * Pure rules for showing a notebook's non-page files: which names are images
 * or videos, how to tell a binary file from text, which editor mode a file
 * name asks for, and the URL the asset protocol serves a tree file from.
 * No Electron, no filesystem — the disk half lives in main.
 */
import { BRAND } from '../brand'
import { WRITING_ASSET_HOST } from './types'

/** Extensions the file viewer can paint in an <img>. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff']
/** Extensions the file viewer can play in a <video>. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']

export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at + 1).toLowerCase()
}

/** What a file name promises before anyone reads the bytes: an image, a video, or a file to try as text. */
export function mediaKind(name: string): 'image' | 'video' | null {
  const ext = extensionOf(name)
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  return null
}

/** The usual binary sniff: a NUL byte in the first block means not text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000)
  for (let index = 0; index < end; index++) if (bytes[index] === 0) return true
  return false
}

/** Valid UTF-8 decodes strictly; anything else is not text the editor could save back safely. */
export function decodableAsUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: 'python', pyw: 'python', pyi: 'python',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'javascript', jsonc: 'javascript', ipynb: 'javascript', map: 'javascript',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown'
}

/**
 * The editor mode key a file name asks for ('' = plain text). The keys are the
 * MODES registry of the workbench CodeEditor, shared with the exercise
 * toolchains' highlight ids; a language with no mode there still edits fine,
 * just without highlighting.
 */
export function codeLanguageForFile(name: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(name)] ?? ''
}

/** The asset-protocol URL a tree file is served from: `<scheme>://writing-notebooks/<id>/pages/<path>`. */
export function writingTreeFileUrl(id: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${BRAND.scheme}://${WRITING_ASSET_HOST}/${id}/pages/${encoded}`
}
