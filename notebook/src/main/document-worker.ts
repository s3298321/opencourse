/** PDF parsing is isolated from Electron main. Pages are acknowledged to bound the queue. */
import { parentPort, workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { DOCUMENT_INDEX_VERSION, type DocumentSection } from '../core/documents/types'
import { pageHeadings, pageText, type PdfTextItem } from '../core/documents/text'
import { pdfResourceRoot } from './pdf-resources'
import { join } from 'node:path'

async function index(): Promise<void> {
  const port = parentPort!
  const { path, password } = workerData as { path: string; password?: string }
  const file = await open(path, 'r')
  let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined
  try {
    const { getDocument, PDFDataRangeTransport } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { size } = await file.stat()
    const read = async (begin: number, end: number): Promise<Uint8Array> => {
      const buffer = new Uint8Array(end - begin)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, begin)
      if (bytesRead !== buffer.length) throw new Error('The PDF ended unexpectedly.')
      return buffer
    }
    class LocalRange extends PDFDataRangeTransport {
      requestDataRange(begin: number, end: number): void {
        void read(begin, end).then(data => this.onDataRange(begin, data)).catch(error => { void task?.destroy(); port.postMessage({ type: 'error', message: error.message }) })
      }
    }
    const range = new LocalRange(size, await read(0, Math.min(size, 65536)))
    task = getDocument({ range, password, disableAutoFetch: true, disableStream: true, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
      cMapUrl: `${join(pdfResourceRoot(), 'cmaps')}/`, standardFontDataUrl: `${join(pdfResourceRoot(), 'standard_fonts')}/`, wasmUrl: `${join(pdfResourceRoot(), 'wasm')}/` })
    const pdf = await task.promise
    if (pdf.numPages > 100_000) throw new Error('This PDF exceeds the 100,000 page limit.')
    const metadata = await pdf.getMetadata().catch(() => null)
    const title = (metadata?.info as { Title?: unknown } | undefined)?.Title
    const outline = await pdf.getOutline()
    const sections: DocumentSection[] = []
    const visit = async (entries: NonNullable<typeof outline>, depth: number): Promise<void> => {
      for (const entry of entries) {
        if (sections.length >= 2000 || depth > 12) return
        try {
          const destination = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest
          if (destination) {
            const page = typeof destination[0] === 'number' ? destination[0] + 1 : await pdf.getPageIndex(destination[0]) + 1
            if (page >= 1 && page <= pdf.numPages) {
              const y = destination[1]?.name === 'XYZ' ? destination[3] : destination[1]?.name === 'FitH' ? destination[2] : null
              let top: number | undefined
              if (typeof y === 'number') {
                const target = await pdf.getPage(page)
                top = Math.max(0, target.getViewport({ scale: 1 }).convertToViewportPoint(0, y)[1]!)
              }
              sections.push({ id: `outline-${sections.length}`, title: entry.title.slice(0, 200), page, depth, ...(top !== undefined ? { top } : {}) })
            }
          }
        } catch { /* A broken bookmark must not prevent reading the PDF. */ }
        await visit(entry.items, depth + 1)
      }
    }
    if (outline) await visit(outline, 0)
    const hasOutline = sections.length > 0
    port.postMessage({ type: 'metadata', pages: pdf.numPages, title: typeof title === 'string' ? title.slice(0, 300) : null, sections })
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const items = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item)
      const headings = hasOutline ? [] : pageHeadings(items, pageNumber, page.getViewport({ scale: 1 }).height)
      const acknowledged = new Promise<void>(resolve => port.once('message', () => resolve()))
      port.postMessage({ type: 'page', page: pageNumber, text: pageText(items), headings })
      await acknowledged
      page.cleanup()
    }
    port.postMessage({ type: 'done', version: DOCUMENT_INDEX_VERSION })
  } finally {
    await task?.destroy()
    await file.close()
  }
}
void index().catch(error => parentPort?.postMessage({ type: 'error', message: error?.name === 'PasswordException' ? 'This PDF needs a password. Unlock it to build its text index.' : `Could not read this PDF: ${error instanceof Error ? error.message : 'Unknown error'}` }))
