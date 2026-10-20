import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const resourceRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
let task
try {
  task = getDocument({
    data: new Uint8Array(await readFile(workerData.path)),
    isEvalSupported: false,
    cMapUrl: `${join(resourceRoot, 'cmaps')}/`,
    standardFontDataUrl: `${join(resourceRoot, 'standard_fonts')}/`,
    wasmUrl: `${join(resourceRoot, 'wasm')}/`,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false
  })
  const pdf = await task.promise
  if (pdf.numPages > 10000) throw new Error('Document exceeds 10,000 pages.')
  const sections = [],
    texts = []
  async function outline(entries, depth = 0) {
    for (const entry of entries ?? []) {
      if (sections.length >= 2000 || depth > 12) return
      try {
        const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest
        if (dest)
          sections.push({
            id: `section-${sections.length}`,
            title: entry.title.slice(0, 200),
            page: typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1,
            depth
          })
      } catch {}
      await outline(entry.items, depth + 1)
    }
  }
  await outline(await pdf.getOutline())
  let size = 0
  for (let page = 1; page <= (workerData.metadataOnly ? 0 : pdf.numPages); page++) {
    const p = await pdf.getPage(page),
      text = (await p.getTextContent()).items
        .filter((i) => 'str' in i)
        .map((i) => i.str + (i.hasEOL ? '\n' : ' '))
        .join('')
        .slice(0, 64000)
    size += text.length
    if (size > 32 * 1024 * 1024) throw new Error('Extracted document text exceeds 32 MiB.')
    texts.push(text)
    p.cleanup()
  }
  parentPort.postMessage({ pages: pdf.numPages, sections, texts })
} catch (error) {
  parentPort.postMessage({
    error:
      error.name === 'PasswordException'
        ? 'Password-protected PDFs cannot be published. Publish an unlocked copy.'
        : 'This PDF could not be indexed.'
  })
} finally {
  await task?.destroy()
}
