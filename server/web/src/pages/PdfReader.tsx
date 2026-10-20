import { ArrowLeft, Check, ChevronDown, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ContentRef } from '@core/learning/types'
import type { DocumentSection } from '@core/documents/types'
import { documentProgressPercent } from '@core/documents/progress'
import { anchoredScrollTop, pageAt, parsePageNumber, parseZoomPercent, stepZoom } from '@core/documents/view'
import PdfPage from '../../../../app/src/learning-ui/PdfPage'
import DocumentOutline from '../../../../app/src/learning-ui/DocumentOutline'
import { call } from '../lib/api'
GlobalWorkerOptions.workerSrc = workerUrl
const resourceUrls = import.meta.glob<string>('../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  eager: true,
  query: '?url',
  import: 'default'
})
class WebPdfResources {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = (
      { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as Record<string, string>
    )[kind]
    if (!directory || !/^[a-z\d_.-]{1,150}$/i.test(filename) || filename.includes('..'))
      throw new Error('Invalid PDF resource.')
    const url = resourceUrls[`../../../node_modules/pdfjs-dist/${directory}/${filename}`]
    if (!url) throw new Error('Missing PDF resource.')
    const response = await fetch(url)
    if (!response.ok) throw new Error('Could not load PDF resource.')
    return new Uint8Array(await response.arrayBuffer())
  }
}
function parseSections(raw: string): DocumentSection[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s): s is Partial<DocumentSection> => Boolean(s) && typeof s === 'object')
      .filter((s) => typeof s.title === 'string' && Number.isInteger(s.page))
      .map((s, i) => ({
        id: typeof s.id === 'string' ? s.id : `section-${i}`,
        title: s.title!,
        page: s.page!,
        depth: Number.isInteger(s.depth) ? s.depth! : 0,
        ...(typeof s.top === 'number' ? { top: s.top } : {})
      }))
  } catch {
    return []
  }
}
interface Search {
  query: string
  hits: { page: number; excerpt: string }[]
  status?: string
}
const GAP = 24

/**
 * The web's PDF reader, laid out as the app's (app/src/renderer/routes/Document.tsx):
 * the headings on the left, one toolbar - pages, reading progress, zoom, find -
 * over a column of pages that scrolls continuously. The pages and the outline
 * are the app's own components.
 */
export function PdfReader({
  source,
  document,
  initialPage,
  requestedPage,
  readPage,
  onPage,
  onRead,
  zoom,
  onZoom,
  outlineKey
}: {
  source: ContentRef
  document: { title: string; pages: number; sections: string }
  initialPage: number
  requestedPage?: { page: number } | null
  readPage: number
  onPage: (page: number) => void
  onRead: (page: number) => void
  zoom: number
  onZoom: (value: number) => void
  outlineKey: string
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(''),
    [page, setPage] = useState(1),
    [pageInput, setPageInput] = useState('1'),
    [readingTop, setReadingTop] = useState(0),
    [positionReady, setPositionReady] = useState(false),
    [outlineRevealSignal, setOutlineRevealSignal] = useState(0),
    [outlineOpen, setOutlineOpen] = useState(false),
    [paneWidth, setPaneWidth] = useState(640),
    [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({}),
    [editingZoom, setEditingZoom] = useState(false),
    [findOpen, setFindOpen] = useState(false),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState<Search | null>(null)
  const reader = useRef<HTMLDivElement>(null),
    findField = useRef<HTMLInputElement>(null),
    base = `/api/v1/learn/document/${source.id}/${source.version}`
  useEffect(() => {
    const task = getDocument({
      url: `${base}/pdf`,
      withCredentials: true,
      useWorkerFetch: false,
      BinaryDataFactory: WebPdfResources
    })
    let cancelled = false
    void task.promise.then(setPdf).catch((e) => {
      // Destroying a load in progress rejects it with "Loading aborted".
      if (!cancelled) setError(e.message)
    })
    return () => {
      cancelled = true
      setPdf(null)
      void task.destroy()
    }
  }, [base])
  useEffect(() => {
    const element = reader.current
    if (!element) return
    // The column animates when the chat opens: re-render the pages once it has
    // settled, not at every frame, which blanks them while they redraw.
    let timer = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setPaneWidth(element.clientWidth), 120)
    })
    observer.observe(element)
    setPaneWidth(element.clientWidth)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])
  useEffect(() => setPageInput(String(page)), [page])
  const measured = useCallback((number: number, width: number, height: number) => {
    setSizes((current) =>
      current[number]?.width === width && current[number]?.height === height
        ? current
        : { ...current, [number]: { width, height } }
    )
  }, [])
  const count = pdf?.numPages ?? document.pages ?? 1
  const sizeOf = sizes[1] ?? Object.values(sizes)[0] ?? { width: 612, height: 792 }
  const pageWidth = Math.max(1, paneWidth - GAP * 2) * zoom
  // Each page fits on its own: a cover, a rotated page and a body page can differ in width.
  const pageScale = useCallback(
    (number: number) => pageWidth / (sizes[number]?.width ?? sizeOf.width),
    [pageWidth, sizes, sizeOf.width]
  )
  const offsets = useMemo(() => {
    const positions = [GAP]
    for (let number = 1; number <= count; number++)
      positions.push(positions.at(-1)! + (sizes[number]?.height ?? sizeOf.height) * pageScale(number) + GAP)
    return positions
  }, [count, sizes, sizeOf.height, pageScale])
  useLayoutEffect(() => {
    if (zoom <= 1 && reader.current) reader.current.scrollLeft = 0
  }, [zoom, paneWidth])
  // A zoom or a page measured late moves every page below it: keep the one being read in place.
  const positions = useRef(offsets)
  positions.current = offsets
  const previousOffsets = useRef(offsets)
  useLayoutEffect(() => {
    const element = reader.current,
      previous = previousOffsets.current
    if (element && previous !== offsets) element.scrollTop = anchoredScrollTop(previous, offsets, element.scrollTop, GAP)
    previousOffsets.current = offsets
  }, [offsets])
  // Scrolling passes many pages; the position is saved once it settles.
  const savedPage = useRef(0),
    saveTimer = useRef(0)
  const rememberPage = useCallback(
    (number: number) => {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        if (savedPage.current === number) return
        savedPage.current = number
        onPage(number)
      }, 600)
    },
    [onPage]
  )
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])
  const jump = useCallback(
    (number: number, top = 0) => {
      if (!Number.isSafeInteger(number) || number < 1 || number > count) return
      setPage(number)
      setReadingTop(top)
      rememberPage(number)
      if (reader.current)
        reader.current.scrollTop = Math.max(0, positions.current[number - 1]! + top * pageScale(number) - GAP)
    },
    [count, pageScale, rememberPage]
  )
  const visitedCitation = useRef<typeof requestedPage>(null)
  useEffect(() => {
    if (!requestedPage || !pdf || !positionReady || visitedCitation.current === requestedPage) return
    visitedCitation.current = requestedPage
    jump(requestedPage.page)
  }, [requestedPage, pdf, positionReady, jump])
  // Anything but a whole page number in range puts the previous value back.
  const commitPage = (text: string) => {
    const number = parsePageNumber(text, count)
    if (number !== null) jump(number)
    setPageInput(String(number ?? page))
  }
  const outlinePage = useRef('1')
  const commitOutlinePage = (input: HTMLInputElement) => {
    const number = parsePageNumber(input.value, count)
    if (number !== null) {
      outlinePage.current = String(number)
      jump(number)
    }
    input.value = outlinePage.current
  }
  useLayoutEffect(() => {
    if (positionReady || !pdf) return
    const number = Math.max(1, Math.min(pdf.numPages, initialPage || 1))
    savedPage.current = number
    jump(number)
    setPositionReady(true)
  }, [positionReady, pdf, initialPage, jump])
  const sections = useMemo(
    () => parseSections(document.sections),
    [document.sections]
  )
  const ordered = useMemo(
    () => [...sections].sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0)),
    [sections]
  )
  const currentSection = ordered.reduce(
    (found, section, index) =>
      section.page < page || (section.page === page && (section.top ?? 0) <= readingTop + 40) ? index : found,
    -1
  )
  // Find, as in the app: ⌘F / Ctrl+F opens it while the document is open, Escape closes it.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
        findField.current?.focus()
      }
      if (event.key === 'Escape') setFindOpen(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    if (findOpen) findField.current?.focus()
  }, [findOpen])
  useEffect(() => {
    const q = query.trim()
    if (!findOpen || !q) {
      setSearch(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void call<Omit<Search, 'query'>>('GET', `/learn/document/${source.id}/${source.version}/search?q=${encodeURIComponent(q)}`)
        .then((result) => {
          if (!cancelled) setSearch({ query: q, ...result })
        })
        .catch((e) => {
          if (!cancelled) setError(e.message)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source.id, source.version, query, findOpen])
  const visiblePages = useMemo(() => {
    const pages: number[] = []
    for (let number = Math.max(1, page - 2); number <= Math.min(count, page + 3); number++) pages.push(number)
    return pages
  }, [page, count])
  const read = Math.min(readPage, count)
  const progressPercent = documentProgressPercent({ pages: count, readPage: read })
  const progressDescription = read ? `Read through page ${read} of ${count}` : 'No reading progress marked yet'
  const zoomPercent = Number((zoom * 100).toPrecision(12))
  const applyZoom = (input: string): void => {
    const value = parseZoomPercent(input)
    if (value !== null) onZoom(value)
    setEditingZoom(false)
  }
  return (
    <div className="web-document">
      <aside className="document-sidebar" data-expanded={outlineOpen}>
        <header className="document-sidebar-head">
          <Link className="back-link" to="/learning">
            <ArrowLeft aria-hidden /> My learning
          </Link>
          <h1>{document.title}</h1>
        </header>
        <button
          className="outline-mobile-toggle"
          aria-expanded={outlineOpen}
          aria-controls="document-outline-navigation"
          onClick={() => setOutlineOpen((value) => !value)}
        >
          Contents
          <ChevronDown aria-hidden />
        </button>
        <nav id="document-outline-navigation" className="document-outline" aria-label="Document headings">
          {sections.length ? (
            <DocumentOutline
              key={outlineKey}
              storageKey={outlineKey}
              positionReady={positionReady}
              sections={sections}
              currentId={ordered[currentSection]?.id}
              jump={(number, top) => {
                jump(number, top)
                setOutlineOpen(false)
              }}
              revealSignal={outlineRevealSignal}
            />
          ) : (
            <div className="document-outline-empty">
              <p className="meta">No reliable headings found. Navigate by page.</p>
              <label>
                Go to page
                <input
                  aria-label="Outline page number"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  defaultValue={outlinePage.current}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) => commitOutlinePage(event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.currentTarget.value = outlinePage.current
                    }
                  }}
                />
              </label>
            </div>
          )}
        </nav>
      </aside>
      <div className="document-center">
        <div className="document-toolbar">
          <button className="ghost" onClick={() => jump(page - 1)} disabled={page <= 1} aria-label="Previous page">
            ←
          </button>
          <form onSubmit={(event) => event.preventDefault()}>
            <label className="oc-visually-hidden" htmlFor="document-page">
              Page
            </label>
            <input
              id="document-page"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => commitPage(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setPageInput(String(page))
                }
              }}
            />
            <span className="meta">/ {count}</span>
          </form>
          <button className="ghost" onClick={() => jump(page + 1)} disabled={page >= count} aria-label="Next page">
            →
          </button>
          <div className="document-reading-progress">
            <button
              className="document-progress-jump"
              aria-label="Go to last read page"
              title={read ? `Go to page ${read} · ${progressDescription}` : progressDescription}
              disabled={!read || !pdf || !positionReady}
              onClick={() => {
                jump(read)
                setOutlineRevealSignal((signal) => signal + 1)
              }}
            >
              <progress aria-label="Reading progress" aria-valuetext={progressDescription} max={Math.max(1, count)} value={read} />
            </button>
            <span className="document-progress-percent" title={progressDescription}>
              {progressPercent}%
            </span>
            <button
              className="oc-btn secondary sm"
              disabled={!pdf || !positionReady}
              onClick={() => onRead(page)}
              title={`Mark page ${page} as the last page read`}
            >
              <Check aria-hidden /> Mark progress
            </button>
          </div>
          <button className="ghost" aria-label="Zoom out" onClick={() => onZoom(stepZoom(zoom, 'out'))}>
            −
          </button>
          {editingZoom ? (
            <input
              aria-label="Zoom percentage"
              type="text"
              inputMode="decimal"
              defaultValue={zoomPercent}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => applyZoom(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditingZoom(false)
                }
              }}
            />
          ) : (
            <button className="ghost" aria-label="Edit zoom percentage" onClick={() => setEditingZoom(true)}>
              {zoomPercent}%
            </button>
          )}
          <button className="ghost" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => onZoom(stepZoom(zoom, 'in'))}>
            +
          </button>
          <button
            className="oc-btn secondary sm"
            title="Fit page width"
            onClick={() => {
              onZoom(1)
              if (reader.current) reader.current.scrollLeft = 0
            }}
          >
            Fit
          </button>
          <button className="oc-btn secondary sm" aria-pressed={findOpen} onClick={() => setFindOpen((value) => !value)}>
            Find
          </button>
        </div>
        {error && (
          <p className="document-notice error" role="alert">
            {error}
          </p>
        )}
        {findOpen && (
          <div className="document-find">
            <div className="document-find-field">
              <input
                ref={findField}
                type="search"
                aria-label="Find in document"
                placeholder="Find in document…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button className="ghost" onClick={() => setFindOpen(false)} aria-label="Close document search">
                <X aria-hidden />
              </button>
            </div>
            {search && (
              <div className="document-find-results">
                <p className="meta">
                  {search.hits.length
                    ? `${search.hits.length}${search.hits.length >= 30 ? '+' : ''} results`
                    : search.status === 'indexing'
                      ? 'Search index still building'
                      : 'No matches'}
                </p>
                {search.hits.map((hit) => (
                  <button key={hit.page} className="document-search-hit" onClick={() => jump(hit.page)}>
                    <strong>Page {hit.page}</strong>
                    <span>{hit.excerpt}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          className="pdf-scroll"
          ref={reader}
          onScroll={(event) => {
            if (!positionReady || !pdf) return
            const top = event.currentTarget.scrollTop,
              next = pageAt(offsets, top + GAP + 1)
            if (next !== page) rememberPage(next)
            setPage(next)
            setReadingTop(Math.max(0, (top - offsets[next - 1]!) / pageScale(next)))
          }}
        >
          {!pdf && !error && <p className="meta pdf-loading">Opening PDF…</p>}
          {pdf && (
            <div
              className="pdf-pages"
              style={{ height: offsets.at(-1), width: zoom <= 1 ? paneWidth : Math.max(paneWidth, pageWidth + GAP * 2) }}
            >
              {visiblePages.map((number) => (
                <PdfPage
                  key={number}
                  pdf={pdf}
                  number={number}
                  scale={pageScale(number)}
                  top={offsets[number - 1]!}
                  measured={measured}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
