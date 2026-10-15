import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatQuote, UserProfile } from '@core/types'
import type { DocumentSearch, DocumentSection, DocumentView } from '@core/documents/types'
import { MAX_QUOTE_CHARS } from '@core/sidechat/thread'
import TitleBar from '../components/TitleBar'
import ChatToggle from '../components/ChatToggle'
import ChatPanel from '../components/ChatPanel'
import PdfPage from '../documents/PdfPage'
import { usePdf } from '../documents/usePdf'
import { useDocumentChat } from '../documents/useDocumentChat'
import DocumentTitle from '../documents/DocumentTitle'
import type { Route, Screen } from '../routes'
import { useScreenActive } from '../screen-activity'

const GAP = 24, HIGHLIGHT = 'document-ask-quote'
interface SelectionOffer { text: string; page?: number; from: 'document' | 'answer'; range: Range; x: number; y: number }
function mark(range: Range | null): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return
  if (range) CSS.highlights.set(HIGHLIGHT, new Highlight(range)); else CSS.highlights.delete(HIGHLIGHT)
}
function pageAt(offsets: number[], top: number): number {
  let low = 0, high = offsets.length - 2
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (offsets[middle]! <= top) low = middle; else high = middle - 1 }
  return low + 1
}
export default function DocumentReader({ documentId, user, route, navigate, navSignal, findSignal }: {
  documentId: string; user: UserProfile | null; route: Screen; navigate: (route: Route) => void
  navSignal: { action: 'prev' | 'next'; n: number } | null; findSignal: number
}) {
  const active = useScreenActive()
  const [document, setDocument] = useState<DocumentView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1), [pageInput, setPageInput] = useState('1')
  const [positionReady, setPositionReady] = useState(false)
  const savedPage = useRef(1)
  const [readingTop, setReadingTop] = useState(0)
  const [zoom, setZoom] = useState(1), [paneWidth, setPaneWidth] = useState(640)
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({})
  const [chatOpen, setChatOpen] = useState(true)
  const [quote, setQuote] = useState<ChatQuote | null>(null), [offer, setOffer] = useState<SelectionOffer | null>(null)
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(''), [search, setSearch] = useState<DocumentSearch | null>(null)
  const [password, setPassword] = useState('')
  const reader = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null), findField = useRef<HTMLInputElement>(null)
  const lastNav = useRef(navSignal?.n ?? 0), lastFind = useRef(findSignal)
  const refresh = useCallback(() => {
    void window.opencourse.getDocument(documentId).then(setDocument).catch(error => setError(error.message))
  }, [documentId])
  useEffect(refresh, [refresh])
  useEffect(() => window.opencourse.onDocumentsChanged(id => { if (id === documentId) refresh() }), [documentId, refresh])
  const { pdf, error: pdfError, unlock } = usePdf(documentId, document?.bytes ?? 0)
  const storageKey = `document-chat:${user?.id}:${documentId}`
  const panel = useDocumentChat(documentId, page, active && chatOpen, storageKey)
  useEffect(() => { setPageInput(String(page)) }, [page])
  useEffect(() => {
    const element = reader.current
    if (!element) return
    const observer = new ResizeObserver(() => setPaneWidth(element.clientWidth))
    observer.observe(element); setPaneWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])
  const measured = useCallback((number: number, width: number, height: number) => {
    setSizes(current => current[number]?.width === width && current[number]?.height === height ? current : { ...current, [number]: { width, height } })
  }, [])
  const base = sizes[1] ?? { width: 612, height: 792 }
  const scale = Math.max(0.2, Math.min(3, (paneWidth - 48) / base.width * zoom))
  const count = pdf?.numPages ?? document?.pages ?? 1
  const offsets = useMemo(() => {
    const positions = [GAP]
    for (let number = 1; number <= count; number++) positions.push(positions.at(-1)! + (sizes[number]?.height ?? base.height) * scale + GAP)
    return positions
  }, [count, sizes, base.height, scale])
  const positions = useRef(offsets); positions.current = offsets
  const previousOffsets = useRef(offsets)
  const pendingJump = useRef<{ page: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = reader.current, previous = previousOffsets.current
    if (element && pdf && pendingJump.current) {
      const target = pendingJump.current
      element.scrollTop = Math.max(0, offsets[target.page - 1]! + target.top * scale - GAP)
      pendingJump.current = null
    } else if (element && previous !== offsets) {
      const anchor = pageAt(previous, element.scrollTop + GAP + 1) - 1
      if (offsets[anchor] !== undefined && previous[anchor] !== undefined) {
        const ratio = (offsets[anchor + 1]! - offsets[anchor]!) / (previous[anchor + 1]! - previous[anchor]!)
        element.scrollTop = Math.max(0, offsets[anchor]! + (element.scrollTop - previous[anchor]!) * ratio)
      }
    }
    previousOffsets.current = offsets
  }, [offsets, pdf, page, scale])
  const rememberPage = useCallback((number: number) => {
    if (!positionReady || !active || !pdf || savedPage.current === number) return
    savedPage.current = number
    void window.opencourse.setDocumentPage(documentId, number).catch(error => setError(error.message))
  }, [positionReady, active, pdf, documentId])
  const jump = useCallback((number: number, top = 0) => {
    if (!Number.isSafeInteger(number) || number < 1 || number > count) return
    rememberPage(number)
    pendingJump.current = { page: number, top }
    setPage(number); setReadingTop(top); setOffer(null)
    if (pdf && reader.current) {
      reader.current.scrollTop = Math.max(0, positions.current[number - 1]! + top * scale - GAP)
      pendingJump.current = null
    }
  }, [count, scale, pdf, rememberPage])
  useLayoutEffect(() => {
    if (positionReady || !active || !document || !pdf) return
    const number = Math.max(1, Math.min(pdf.numPages, document.lastPage))
    savedPage.current = number
    jump(number)
    setPositionReady(true)
  }, [positionReady, active, document, pdf, jump])
  const sections = useMemo(() => [...(document?.sections ?? [])].sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0)), [document?.sections])
  const currentSection = sections.reduce((found, section, index) => section.page < page || (section.page === page && (section.top ?? 0) <= readingTop + 40) ? index : found, -1)
  const goSection = useCallback((direction: 'prev' | 'next') => {
    const index = direction === 'next' ? currentSection + 1 : currentSection - 1
    const section = sections[index]
    if (section) jump(section.page, section.top)
    else if (!sections.length) jump(page + (direction === 'next' ? 1 : -1))
  }, [currentSection, sections, page, jump])
  useEffect(() => {
    if (!navSignal || lastNav.current === navSignal.n) return
    lastNav.current = navSignal.n
    if (active) goSection(navSignal.action)
  }, [active, navSignal, goSection])
  useEffect(() => { if (lastFind.current !== findSignal) { lastFind.current = findSignal; if (active) setFindOpen(true) } }, [findSignal, active])
  useEffect(() => { if (active && findOpen) findField.current?.focus() }, [active, findOpen])
  useEffect(() => {
    if (!findOpen || !query.trim()) { setSearch(null); return }
    let cancelled = false
    const timer = setTimeout(() => { void window.opencourse.searchDocument(documentId, query).then(result => { if (!cancelled) setSearch(result) }).catch(error => { if (!cancelled) setError(error.message) }) }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [documentId, query, findOpen, document?.indexedPages])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true) }
      if (event.key === 'Escape') { setFindOpen(false); setOffer(null) }
    }
    window.addEventListener('keydown', key)
    const selected = (): void => {
      const selection = window.getSelection()
      if (!selection?.rangeCount || !selection.toString().trim()) { setOffer(null); return }
      const range = selection.getRangeAt(0), element = (node: Node): Element | null => node instanceof Element ? node : node.parentElement
      const start = element(range.startContainer)?.closest('[data-ask]'), end = element(range.endContainer)?.closest('[data-ask]')
      if (!start || start !== end || !host.current?.contains(start)) { setOffer(null); return }
      const from = start.getAttribute('data-ask')
      if (from !== 'document' && from !== 'answer') { setOffer(null); return }
      const bounds = range.getBoundingClientRect()
      if (!bounds.width && !bounds.height) return
      setOffer({ text: selection.toString().trim().slice(0, MAX_QUOTE_CHARS), page: from === 'document' ? Number(start.getAttribute('data-page')) : undefined, from, range: range.cloneRange(), x: bounds.left + bounds.width / 2, y: Math.max(bounds.top, reader.current?.getBoundingClientRect().top ?? 40) })
    }
    const mouseup = (event: MouseEvent): void => { if (!(event.target as Element)?.closest('.ask-about')) selected() }
    const keyup = (event: KeyboardEvent): void => { if (event.shiftKey) selected() }
    window.addEventListener('mouseup', mouseup); window.addEventListener('keyup', keyup)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mouseup', mouseup); window.removeEventListener('keyup', keyup) }
  }, [active])
  useEffect(() => () => mark(null), [])
  const attach = (): void => {
    if (!offer) return
    mark(offer.range)
    setQuote({ text: offer.text, from: offer.from, ...(offer.page ? { document: { id: documentId, page: offer.page } } : {}) })
    setOffer(null); setChatOpen(true)
  }
  const clearQuote = (): void => { setQuote(null); mark(null) }
  const visiblePages = useMemo(() => {
    const pages: number[] = []
    for (let number = Math.max(1, page - 2); number <= Math.min(count, page + 3); number++) pages.push(number)
    // Keep the selected text layer mounted while a quote is in the composer.
    if (quote?.document && !pages.includes(quote.document.page)) pages.push(quote.document.page)
    return pages.sort((a, b) => a - b)
  }, [page, count, quote?.document])
  const completion = async (): Promise<void> => {
    if (document) try { setDocument(await window.opencourse.setDocumentCompleted(documentId, !document.completed)) } catch (error) { setError((error as Error).message) }
  }
  const sectionLink = (section: DocumentSection, index: number) => <button key={section.id} className={`document-section${index === currentSection ? ' active' : ''}`} style={{ paddingLeft: 16 + Math.min(section.depth, 4) * 12 }} aria-current={index === currentSection ? 'location' : undefined} onClick={() => jump(section.page, section.top)} title={section.title}><span>{section.title}</span><small>{section.page}</small></button>
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Documents', onClick: () => navigate({ name: 'documents' }) }} actions={<ChatToggle open={chatOpen} subject="document" onClick={() => setChatOpen(value => !value)} />} />
    <div className="body document-reader" ref={host}>
      <aside className="document-sidebar scroll">
        <div className="document-sidebar-head"><span className="meta">LOCAL PDF</span>{document ? <DocumentTitle title={document.title} onRename={async title => { setDocument(await window.opencourse.renameDocument(documentId, title)) }} /> : <h2>Loading document…</h2>}<ActionButton icon="check" className="secondary document-completed" aria-pressed={document?.completed ?? false} disabled={!document} onClick={() => void completion()}>{document?.completed ? 'Completed · Mark incomplete' : 'Mark completed'}</ActionButton></div>
        <nav aria-label="Document headings">{sections.length ? sections.map(sectionLink) : <div className="document-outline-empty"><p className="meta">{document?.status === 'indexing' ? 'Finding headings…' : 'No reliable headings found. Navigate by page.'}</p><label>Go to page<input aria-label="Outline page number" type="number" min="1" max={count} defaultValue="1" onKeyDown={event => { if (event.key === 'Enter') jump(Number(event.currentTarget.value)) }} /></label></div>}</nav>
      </aside>
      <main className="document-center">
        <div className="document-toolbar">
          <button className="ghost" onClick={() => jump(page - 1)} disabled={page === 1} aria-label="Previous page">←</button>
          <form onSubmit={event => { event.preventDefault(); jump(Number(pageInput)) }}><label className="sr-only" htmlFor="document-page">Page</label><input id="document-page" type="number" min="1" max={count} value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => { jump(Number(pageInput)); setPageInput(String(page)) }} /><span className="meta">/ {count}</span></form>
          <button className="ghost" onClick={() => jump(page + 1)} disabled={page === count} aria-label="Next page">→</button>
          <span className="document-toolbar-spacer" />
          <button className="ghost" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}>−</button><button className="ghost" onClick={() => setZoom(1)} title="Fit page width">{Math.round(zoom * 100)}%</button><button className="ghost" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.25))}>+</button><button className="ghost" aria-pressed={findOpen} onClick={() => setFindOpen(value => !value)}>Find</button>
        </div>
        {(error || pdfError) && <p className="document-notice error" role="alert">{error ?? pdfError}</p>}
        {document?.status === 'indexing' && <p className="document-notice">Building text search · {document.indexedPages}{document.pages ? ` of ${document.pages}` : ''} pages indexed. You can read now.</p>}
        {document?.status === 'error' && !unlock && <div className="document-notice">{document.error}<button className="ghost" onClick={() => void window.opencourse.retryDocumentIndex(documentId).then(refresh).catch(error => setError(error.message))}>Retry text index</button></div>}
        {document?.status === 'ready' && document.searchablePages === 0 && <p className="document-notice">This PDF contains images without extractable text. You can read it; text selection and document search need OCR.</p>}
        {unlock && <form className="document-unlock" onSubmit={event => { event.preventDefault(); unlock(password); setPassword('') }}><label>This PDF needs a password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus /></label><ActionButton icon="lock">Unlock PDF</ActionButton></form>}
        {findOpen && <div className="document-find"><div className="document-find-field"><input ref={findField} type="search" aria-label="Find in document" placeholder="Find in document…" value={query} onChange={event => setQuery(event.target.value)} /><button className="ghost" onClick={() => setFindOpen(false)} aria-label="Close document search">✕</button></div>{search && <div className="document-find-results"><p className="meta">{search.complete ? search.hits.length ? `${search.hits.length}${search.more ? '+' : ''} results` : 'No matches' : `Search index incomplete · ${search.indexedPages} of ${search.pages} pages`}</p>{search.hits.map(hit => <button key={hit.page} className="document-search-hit" onClick={() => jump(hit.page)}><strong>Page {hit.page}</strong><span>{hit.excerpt}</span></button>)}{search.more && <button className="ghost" onClick={() => void window.opencourse.searchDocument(documentId, query, search.hits.length).then(next => setSearch(current => current ? { ...next, hits: [...current.hits, ...next.hits] } : next)).catch(error => setError(error.message))}>More results</button>}</div>}</div>}
        <div className="pdf-scroll scroll" ref={reader} onScroll={event => { if (!positionReady || !active || !pdf) return; const top = event.currentTarget.scrollTop, next = pageAt(offsets, top + GAP + 1); rememberPage(next); setPage(current => current === next ? current : next); setReadingTop(Math.max(0, (top - offsets[next - 1]!) / scale)); setOffer(null) }}>
          {!pdf && !unlock && !pdfError && <p className="meta pdf-loading">Opening PDF…</p>}
          {pdf && <div className="pdf-pages" style={{ height: offsets.at(-1), width: Math.max(paneWidth, Object.values(sizes).reduce((width, size) => Math.max(width, size.width), base.width) * scale + 48) }}>{visiblePages.map(number => <PdfPage key={number} pdf={pdf} number={number} scale={scale} top={offsets[number - 1]!} measured={measured} />)}</div>}
        </div>
      </main>
      <div className="lesson-chat-host document-chat-host" data-open={chatOpen} inert={!chatOpen} aria-hidden={!chatOpen}><ChatPanel visible={chatOpen} variant="document" panel={panel} quote={quote} onQuoteUsed={clearQuote} onClose={() => setChatOpen(false)} storageKey={storageKey} sourceIcons={window.opencourse.getDocumentSourceIcons}
        onSource={source => { if (source.kind === 'document' && source.documentId === documentId) jump(source.page) }} onAddKey={() => navigate({ name: 'settings', from: route, section: 'connections' })} /></div>
      {active && offer && <button className="ask-about" style={{ left: Math.min(Math.max(offer.x, 64), window.innerWidth - 64), top: offer.y }} onMouseDown={event => event.preventDefault()} onClick={attach}>Ask about this</button>}
    </div>
  </>
}
