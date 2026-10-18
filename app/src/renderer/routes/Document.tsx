import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatQuote, UserProfile } from '@core/types'
import type { DocumentSearch, DocumentView } from '@core/documents/types'
import { documentProgressPercent } from '@core/documents/progress'
import { MAX_QUOTE_CHARS } from '@core/sidechat/thread'
import TitleBar from '../components/TitleBar'
import ChatToggle from '../components/ChatToggle'
import ChatPanel from '../components/ChatPanel'
import PdfPage from '../documents/PdfPage'
import { usePdf } from '../documents/usePdf'
import { useDocumentChat } from '../documents/useDocumentChat'
import DocumentTitle from '../documents/DocumentTitle'
import DocumentOutline from '../documents/DocumentOutline'
import type { Route, Screen } from '../routes'
import { useScreenActive } from '../screen-activity'

const GAP = 24, HIGHLIGHT = 'document-ask-quote'
function stepZoom(value: number, direction: 'in' | 'out'): number {
  const percent = Number((value * 100).toPrecision(12))
  const next = direction === 'out'
    ? percent > 50 ? Math.max(50, percent - 25) : percent > 30 ? Math.max(30, percent - 10) : percent > 5 ? Math.max(5, percent - 5) : percent / 2
    : percent < 5 ? Math.min(5, percent * 2) : percent < 30 ? Math.min(30, percent + 5) : percent < 50 ? Math.min(50, percent + 10) : Math.min(300, percent + 25)
  return Math.max(Number.MIN_VALUE, next / 100)
}
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
  const [savingProgress, setSavingProgress] = useState(false)
  const [outlineRevealSignal, setOutlineRevealSignal] = useState(0)
  const savedPage = useRef(1)
  const [readingTop, setReadingTop] = useState(0)
  const [zoom, setZoom] = useState(1), [paneWidth, setPaneWidth] = useState(640)
  const [editingZoom, setEditingZoom] = useState(false)
  const zoomPercent = Number((zoom * 100).toPrecision(12))
  const applyZoom = (input: string): void => {
    const text = input.trim().replace(/%$/, '').trim(), percent = Number(text)
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(percent) && percent > 0 && percent <= 300 && percent / 100 > 0) setZoom(percent / 100)
    setEditingZoom(false)
  }
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
  const base = sizes[1] ?? Object.values(sizes)[0] ?? { width: 612, height: 792 }
  const pageWidth = Math.max(1, paneWidth - GAP * 2) * zoom
  // Each page fits independently: covers, rotated pages and body pages can differ in width.
  const pageScale = useCallback((number: number) => pageWidth / (sizes[number]?.width ?? base.width), [pageWidth, sizes, base.width])
  const count = pdf?.numPages ?? document?.pages ?? 1
  const offsets = useMemo(() => {
    const positions = [GAP]
    for (let number = 1; number <= count; number++) positions.push(positions.at(-1)! + (sizes[number]?.height ?? base.height) * pageScale(number) + GAP)
    return positions
  }, [count, sizes, base.height, pageScale])
  useLayoutEffect(() => {
    if (zoom <= 1 && reader.current) reader.current.scrollLeft = 0
  }, [zoom, paneWidth])
  const positions = useRef(offsets); positions.current = offsets
  const previousOffsets = useRef(offsets)
  const pendingJump = useRef<{ page: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = reader.current, previous = previousOffsets.current
    if (element && pdf && pendingJump.current) {
      const target = pendingJump.current
      element.scrollTop = Math.max(0, offsets[target.page - 1]! + target.top * pageScale(target.page) - GAP)
      pendingJump.current = null
    } else if (element && previous !== offsets) {
      const anchor = pageAt(previous, element.scrollTop + GAP + 1) - 1
      if (offsets[anchor] !== undefined && previous[anchor] !== undefined) {
        const ratio = (offsets[anchor + 1]! - offsets[anchor]!) / (previous[anchor + 1]! - previous[anchor]!)
        element.scrollTop = Math.max(0, offsets[anchor]! + (element.scrollTop - previous[anchor]!) * ratio)
      }
    }
    previousOffsets.current = offsets
  }, [offsets, pdf, page, pageScale])
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
      reader.current.scrollTop = Math.max(0, positions.current[number - 1]! + top * pageScale(number) - GAP)
      pendingJump.current = null
    }
  }, [count, pageScale, pdf, rememberPage])
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
  const readPage = Math.min(document?.readPage ?? 0, count)
  const progressPercent = documentProgressPercent({ pages: count, readPage })
  const progressDescription = readPage ? `Read through page ${readPage} of ${count}` : 'No reading progress marked yet'
  const markProgress = async (): Promise<void> => {
    if (!document || !pdf || !positionReady || savingProgress) return
    setSavingProgress(true)
    setError(null)
    try { setDocument(await window.opencourse.setDocumentProgress(documentId, page)) }
    catch (error) { setError((error as Error).message) }
    finally { setSavingProgress(false) }
  }
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'Documents', onClick: () => navigate({ name: 'documents' }) }} actions={<ChatToggle open={chatOpen} subject="document" onClick={() => setChatOpen(value => !value)} />} />
    <div className="body document-reader" ref={host}>
      <aside className="document-sidebar">
        <div className="document-sidebar-head">{document ? <DocumentTitle title={document.title} onRename={async title => { setDocument(await window.opencourse.renameDocument(documentId, title)) }} /> : <h2>Loading document…</h2>}</div>
        <nav className="document-outline" aria-label="Document headings">{document?.sections.length ? <DocumentOutline key={documentId} sections={document.sections} currentId={sections[currentSection]?.id} jump={jump} revealSignal={outlineRevealSignal} /> : <div className="document-outline-empty"><p className="meta">{document?.status === 'indexing' ? 'Finding headings…' : 'No reliable headings found. Navigate by page.'}</p><label>Go to page<input aria-label="Outline page number" type="number" min="1" max={count} defaultValue="1" onKeyDown={event => { if (event.key === 'Enter') jump(Number(event.currentTarget.value)) }} /></label></div>}</nav>
      </aside>
      <main className="document-center">
        <div className="document-toolbar">
          <button className="ghost" onClick={() => jump(page - 1)} disabled={page === 1} aria-label="Previous page">←</button>
          <form onSubmit={event => { event.preventDefault(); jump(Number(pageInput)) }}><label className="sr-only" htmlFor="document-page">Page</label><input id="document-page" type="number" min="1" max={count} value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => { jump(Number(pageInput)); setPageInput(String(page)) }} /><span className="meta">/ {count}</span></form>
          <button className="ghost" onClick={() => jump(page + 1)} disabled={page === count} aria-label="Next page">→</button>
          <div className="document-reading-progress">
            <button className="document-progress-jump" aria-label="Go to last read page" title={readPage ? `Go to page ${readPage} · ${progressDescription}` : progressDescription} disabled={!readPage || !pdf || !positionReady} onClick={() => { jump(readPage); setOutlineRevealSignal(signal => signal + 1) }}>
              <progress aria-label="Reading progress" aria-valuetext={progressDescription} max={Math.max(1, count)} value={readPage} />
            </button>
            <span className="document-progress-percent" title={progressDescription}>{progressPercent}%</span>
            <ActionButton icon="check" className="secondary" disabled={!document || !pdf || !positionReady || savingProgress} onClick={() => void markProgress()} title={`Mark page ${page} as the last page read`}>{savingProgress ? 'Saving…' : 'Mark progress'}</ActionButton>
          </div>
          <button className="ghost" aria-label="Zoom out" onClick={() => setZoom(value => stepZoom(value, 'out'))}>−</button>
          {editingZoom ? <input aria-label="Zoom percentage" type="text" inputMode="decimal" defaultValue={zoomPercent} autoFocus onFocus={event => event.currentTarget.select()} onBlur={event => applyZoom(event.currentTarget.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); setEditingZoom(false) }
          }} /> : <button className="ghost" aria-label="Edit zoom percentage" onClick={() => setEditingZoom(true)}>{zoomPercent}%</button>}
          <button className="ghost" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => stepZoom(value, 'in'))}>+</button>
          <button className="action-button secondary" onClick={() => { setZoom(1); if (reader.current) reader.current.scrollLeft = 0 }} title="Fit page width">Fit</button>
          <button className="action-button secondary" aria-pressed={findOpen} onClick={() => setFindOpen(value => !value)}>Find</button>
        </div>
        {(error || pdfError) && <p className="document-notice error" role="alert">{error ?? pdfError}</p>}
        {document?.status === 'indexing' && <p className="document-notice">Building text search · {document.indexedPages}{document.pages ? ` of ${document.pages}` : ''} pages indexed. You can read now.</p>}
        {document?.status === 'error' && !unlock && <div className="document-notice">{document.error}<button className="ghost" onClick={() => void window.opencourse.retryDocumentIndex(documentId).then(refresh).catch(error => setError(error.message))}>Retry text index</button></div>}
        {document?.status === 'ready' && document.searchablePages === 0 && <p className="document-notice">This PDF contains images without extractable text. You can read it; text selection and document search need OCR.</p>}
        {unlock && <form className="document-unlock" onSubmit={event => { event.preventDefault(); unlock(password); setPassword('') }}><label>This PDF needs a password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus /></label><ActionButton icon="lock">Unlock PDF</ActionButton></form>}
        {findOpen && <div className="document-find"><div className="document-find-field"><input ref={findField} type="search" aria-label="Find in document" placeholder="Find in document…" value={query} onChange={event => setQuery(event.target.value)} /><button className="ghost" onClick={() => setFindOpen(false)} aria-label="Close document search">✕</button></div>{search && <div className="document-find-results"><p className="meta">{search.complete ? search.hits.length ? `${search.hits.length}${search.more ? '+' : ''} results` : 'No matches' : `Search index incomplete · ${search.indexedPages} of ${search.pages} pages`}</p>{search.hits.map(hit => <button key={hit.page} className="document-search-hit" onClick={() => jump(hit.page)}><strong>Page {hit.page}</strong><span>{hit.excerpt}</span></button>)}{search.more && <button className="ghost" onClick={() => void window.opencourse.searchDocument(documentId, query, search.hits.length).then(next => setSearch(current => current ? { ...next, hits: [...current.hits, ...next.hits] } : next)).catch(error => setError(error.message))}>More results</button>}</div>}</div>}
        <div className="pdf-scroll scroll" ref={reader} onScroll={event => { if (!positionReady || !active || !pdf) return; const top = event.currentTarget.scrollTop, next = pageAt(offsets, top + GAP + 1); rememberPage(next); setPage(current => current === next ? current : next); setReadingTop(Math.max(0, (top - offsets[next - 1]!) / pageScale(next))); setOffer(null) }}>
          {!pdf && !unlock && !pdfError && <p className="meta pdf-loading">Opening PDF…</p>}
          {pdf && <div className="pdf-pages" style={{ height: offsets.at(-1), width: zoom <= 1 ? paneWidth : Math.max(paneWidth, pageWidth + GAP * 2) }}>{visiblePages.map(number => <PdfPage key={number} pdf={pdf} number={number} scale={pageScale(number)} top={offsets[number - 1]!} measured={measured} />)}</div>}
        </div>
      </main>
      <div className="lesson-chat-host document-chat-host" data-open={chatOpen} inert={!chatOpen} aria-hidden={!chatOpen}><ChatPanel visible={chatOpen} variant="document" panel={panel} quote={quote} onQuoteUsed={clearQuote} onClose={() => setChatOpen(false)} storageKey={storageKey} sourceIcons={window.opencourse.getDocumentSourceIcons}
        onSource={source => { if (source.kind === 'document' && source.documentId === documentId) jump(source.page) }} onAddKey={() => navigate({ name: 'settings', from: route, section: 'connections' })} /></div>
      {active && offer && <button className="ask-about" style={{ left: Math.min(Math.max(offer.x, 64), window.innerWidth - 64), top: offer.y }} onMouseDown={event => event.preventDefault()} onClick={attach}>Ask about this</button>}
    </div>
  </>
}
