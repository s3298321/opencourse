import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { decodeSketch, MAX_SKETCH_BYTES, sketchAsset, sketchReferences, sketchSvg, validateSketch, type SketchColors } from '../core/writing-notebooks/sketch'
import { getWritingNotebook, getWritingPage, writingNotebookDirectory } from './writing-notebooks'

function sketchPath(id: string, asset: string, create = false) {
  if (typeof asset !== 'string' || !sketchAsset.test(asset)) throw new Error('Invalid sketch reference.')
  const directory = writingNotebookDirectory(id)
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid notebook directory.')
  getWritingNotebook(id)
  const assets = join(directory, 'assets')
  if (create) mkdirSync(assets, { recursive: true })
  if (!lstatSync(assets).isDirectory()) throw new Error('Invalid notebook assets directory.')
  return join(directory, asset)
}
function readSvg(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_SKETCH_BYTES) throw new Error('Invalid sketch file.')
  return readFileSync(path, 'utf8')
}
export function readNotebookSketch(id: string, asset: string) {
  return decodeSketch(readSvg(sketchPath(id, asset)))
}
export function saveNotebookSketch(id: string, asset: string, raw: unknown, colors: SketchColors): void {
  const svg = sketchSvg(validateSketch(raw), colors)
  if (Buffer.byteLength(svg) > MAX_SKETCH_BYTES) throw new Error('Sketch is too large to save.')
  const path = sketchPath(id, asset, true)
  if (existsSync(path)) {
    if (readSvg(path) === svg) return // Retry after a lost acknowledgement.
    throw new Error('This sketch version already exists.')
  }
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, svg, { flag: 'wx' })
    linkSync(temp, path) // Publish complete bytes without overwriting another version.
  } finally { if (existsSync(temp)) unlinkSync(temp) }
}

// Both OpenCourse and OpenCourse Notebook can hold the same notebook open, and a
// copied reference may sit on the clipboard. Recent versions stay for them.
const SKETCH_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000
const sketchTemp = /^(.*)\.[0-9a-f-]{36}\.tmp$/

/** Every stroke publishes a new immutable version. Drop the versions no saved
 *  page references any more, plus temp files a crashed write left behind. */
export function pruneNotebookSketches(id: string): void {
  const notebook = getWritingNotebook(id)
  const assets = join(writingNotebookDirectory(id), 'assets')
  if (!existsSync(assets) || !lstatSync(assets).isDirectory()) return
  const referenced = new Set(notebook.pages.flatMap(page => [...sketchReferences(getWritingPage(id, page.id).markdown)]))
  const now = Date.now()
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const temp = sketchTemp.exec(entry.name)
    const asset = `assets/${temp ? temp[1] : entry.name}`
    if (!sketchAsset.test(asset) || (!temp && referenced.has(asset))) continue
    const path = join(assets, entry.name)
    if (now - lstatSync(path).mtimeMs < SKETCH_PRUNE_GRACE_MS) continue
    unlinkSync(path)
  }
}
