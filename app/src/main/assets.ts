import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import type { Attachment } from '../core/course-document'
import type { CourseManifest } from '../core/types'
import { referencedAssets } from '../core/manifest'
/**
 * How course assets become URLs for the renderer.
 *
 * Everything goes through opencourse:// except SVG. Chromium will load an SVG from
 * a custom scheme - it reports the right intrinsic size, `decode()` resolves,
 * and it taints a canvas like any cross-origin image - but it never paints it,
 * so covers and .svg image blocks come out as blank boxes. Registering the
 * scheme with corsEnabled and sending Access-Control-Allow-Origin does not
 * change that. Inlining the file as a data: URL does, and course SVGs are
 * diagrams of a few KB.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { assetUrl, type AssetResolver } from '../core/manifest'
import { resolveInside } from '../core/safepath'

/** Bigger SVGs stay on opencourse:// rather than bloating every IPC payload. */
export const MAX_INLINE_BYTES = 256 * 1024

export function makeAssetResolver(root: string, slug: string): AssetResolver {
  return (relPath: string): string => {
    if (relPath.toLowerCase().endsWith('.svg')) {
      const file = resolveInside(root, relPath)
      if (file && statSync(file).size <= MAX_INLINE_BYTES) {
        return `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`
      }
    }
    return assetUrl(slug, relPath)
  }
}

/** Imported dependencies are retained conservatively; their attachment records still have local IDs. */
export function importedAttachments(root: string, manifest: CourseManifest | null): Attachment[] {
  if (!manifest) return []
  const files: string[] = []
  const walk = (parent: string, prefix = ''): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) walk(join(parent, entry.name), relative + '/')
      else if (entry.isFile()) files.push(relative)
    }
  }
  walk(root)
  return [...new Set(referencedAssets(manifest))].map((entry) => {
    const folder = posix.dirname(entry)
    const bundle = /\.html?$/i.test(entry)
    return { id: randomUUID(), entry, managed: false, files: bundle ? files.filter((f) => folder === '.' || f.startsWith(folder + '/')) : [entry] }
  })
}
