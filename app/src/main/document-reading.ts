import { documentPageText, getDocument, searchDocument } from './documents'
import { boundedResult, MAX_RETRIEVAL_CHARS, nonnegativeInteger, searchQuery, toolArguments, type RetrievalBudget } from '../core/reading/tools'
import type { ReadingSource } from '../core/documents/types'
import { MAX_PAGE_TEXT } from '../core/documents/types'

export function runDocumentReadingTool(id: string, name: string, raw: unknown, budget: RetrievalBudget, sources: ReadingSource[]): string {
  const args = toolArguments(raw), document = getDocument(id)
  const record = (page: number): string => {
    const ref: ReadingSource = { kind: 'document', documentId: id, page, title: `${document.title} · page ${page}` }
    if (!sources.some(item => item.kind === 'document' && item.documentId === id && item.page === page)) sources.push(ref)
    return ref.title
  }
  if (name === 'list_document_sections') {
    const cursor = nonnegativeInteger(args.cursor), sections = document.sections.slice(cursor, cursor + 25)
    return boundedResult({ sections, pages: document.pages, nextCursor: cursor + sections.length < document.sections.length ? cursor + sections.length : null, indexing: document.status === 'indexing' }, budget)
  }
  if (name === 'search_document') {
    const cursor = nonnegativeInteger(args.cursor), result = searchDocument(id, searchQuery(args.query), cursor)
    return boundedResult({ ...result, hits: result.hits.map(hit => ({ ...hit, source: record(hit.page) })), nextCursor: result.more ? cursor + result.hits.length : null,
      ...(document.status === 'error' ? { error: document.error } : {}), ...(document.status === 'ready' && document.searchablePages === 0 ? { notice: 'This PDF has no extractable text. It may be scanned and require local OCR.' } : {}) }, budget)
  }
  if (name === 'read_document_pages') {
    const start = nonnegativeInteger(args.start_page), count = nonnegativeInteger(args.count), offset = nonnegativeInteger(args.offset)
    if (start < 1 || start > document.pages || count < 1 || count > 3) throw new Error('Read between one and three valid pages.')
    const pages: { page: number; source?: string; text?: string; notice?: string; unavailable?: string }[] = []
    let remaining = MAX_RETRIEVAL_CHARS - 1500, nextPage: number | null = null, nextOffset: number | null = null
    for (let page = start; page < Math.min(start + count, document.pages + 1); page++) {
      const text = documentPageText(id, page)
      if (text === null) { pages.push({ page, unavailable: 'This page has not been indexed yet.' }); continue }
      if (!text) { pages.push({ page, unavailable: 'No extractable text; this page may be scanned.' }); continue }
      const begin = page === start ? offset : 0, passage = text.slice(begin, begin + remaining)
      if (passage) pages.push({ page, source: record(page), text: passage, ...(text.length >= MAX_PAGE_TEXT ? { notice: `Only the first ${MAX_PAGE_TEXT} characters of this unusually dense page were indexed.` } : {}) })
      remaining -= passage.length
      if (begin + passage.length < text.length) { nextPage = page; nextOffset = begin + passage.length; break }
      if (remaining <= 0 && page + 1 < Math.min(start + count, document.pages + 1)) { nextPage = page + 1; nextOffset = 0; break }
    }
    return boundedResult({ pages, nextPage, nextOffset }, budget)
  }
  throw new Error('Unknown document retrieval tool.')
}
