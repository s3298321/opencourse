import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AnnotationMode, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'

export default function PdfPage({ pdf, number, scale, top, measured }: { pdf: PDFDocumentProxy; number: number; scale: number; top: number; measured: (page: number, width: number, height: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0, scaleFactor: scale })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false, render: RenderTask | undefined, layer: TextLayer | undefined
    setError(null)
    void (async () => {
      const page = await pdf.getPage(number), content = await page.getTextContent()
      if (disposed || !canvas.current || !text.current) return
      const viewport = page.getViewport({ scale }), original = page.getViewport({ scale: 1 })
      measured(number, original.width, original.height)
      setSize({ width: viewport.width, height: viewport.height, scaleFactor: scale * page.userUnit })
      const element = canvas.current, container = text.current
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)))
      element.width = Math.floor(viewport.width * density); element.height = Math.floor(viewport.height * density)
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`
      container.replaceChildren()
      render = page.render({ canvas: element, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0], annotationMode: AnnotationMode.DISABLE })
      layer = new TextLayer({ textContentSource: content, container, viewport })
      await Promise.all([render.promise, layer.render()])
      if (!disposed) element.dataset.rendered = 'true'
    })().catch(error => { if (!disposed && error.name !== 'RenderingCancelledException') setError(error.message) })
    return () => {
      disposed = true; render?.cancel(); layer?.cancel()
      // Release canvas memory when a page leaves the virtual window.
      const element = canvas.current
      if (element) { delete element.dataset.rendered; element.width = 0; element.height = 0 }
    }
  }, [pdf, number, scale, measured])
  return <div className="pdf-page" data-pdf-page={number} style={{ top, width: size.width || undefined, height: size.height || undefined, '--total-scale-factor': size.scaleFactor } as CSSProperties}>
    <canvas ref={canvas} aria-label={`PDF page ${number}`} />
    <div className="textLayer" ref={text} data-ask="document" data-page={number} />
    {error && <p className="pdf-page-error" role="alert">Page {number}: {error}</p>}
  </div>
}
