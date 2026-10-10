import { useEffect, useState } from 'react'
import { getDocument, PDFDataRangeTransport, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

class LocalBinaryData {
  fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> { return window.opencourse.readPdfResource(kind, filename) }
}
export function usePdf(id: string, bytes: number) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unlock, setUnlock] = useState<((password: string) => void) | null>(null)
  useEffect(() => {
    if (!bytes) return
    let disposed = false, task: PDFDocumentLoadingTask | undefined, worker: PDFWorker | undefined, port: Worker | undefined
    setPdf(null); setError(null)
    const fail = (error: Error): void => { if (!disposed) setError(error.message) }
    void (async () => {
      const initial = await window.opencourse.readDocumentRange(id, 0, Math.min(bytes, 65536))
      if (disposed) return
      class LocalRange extends PDFDataRangeTransport {
        requestDataRange(begin: number, end: number): void {
          void window.opencourse.readDocumentRange(id, begin, end).then(data => { if (!disposed) this.onDataRange(begin, data) }).catch(error => { fail(error); void task?.destroy().catch(() => {}) })
        }
      }
      // An explicit local worker avoids PDF.js creating a blob wrapper under file://.
      port = new Worker(workerUrl, { type: 'module' })
      worker = PDFWorker.create({ port })
      task = getDocument({ range: new LocalRange(bytes, initial), worker, disableAutoFetch: true, disableStream: true, useWorkerFetch: false, BinaryDataFactory: LocalBinaryData })
      task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
        if (reason === 2 && !disposed) setError('That PDF password was incorrect. Try again.')
        if (!disposed) setUnlock(() => (password: string) => {
          setUnlock(null); setError(null); updatePassword(password)
          void window.opencourse.retryDocumentIndex(id, password).catch(fail)
        })
      }
      const document = await task.promise
      if (!disposed) setPdf(document)
    })().catch(fail)
    return () => {
      disposed = true; setUnlock(null)
      void task?.destroy().catch(() => {}).finally(() => { worker?.destroy(); port?.terminate() })
      if (!task) { worker?.destroy(); port?.terminate() }
    }
  }, [id, bytes])
  return { pdf, error, unlock }
}
