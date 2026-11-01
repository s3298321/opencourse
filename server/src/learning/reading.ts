import { runCourseReadingTool } from '@core/reading/course'
import { boundedResult, COURSE_TOOLS, DOCUMENT_TOOLS, nonnegativeInteger, searchQuery, toolArguments } from '@core/reading/tools'
import { MAX_PAGE_TEXT } from '@core/documents/types'
import type { ContentRef } from '@core/learning/types'
import type { Ctx } from '../context'
import { badRequest } from '../errors'
import { contentRecord, readCourse } from './content'

/** Same access check as adding content, but strictly read-only: no enrollment or download. */
export async function readLearningContent(ctx: Ctx, account: string, ref: ContentRef, name: string, raw: unknown): Promise<unknown> {
  const allowed = ref.kind === 'course' ? COURSE_TOOLS : DOCUMENT_TOOLS
  if (!allowed.some(t => t.name === name)) throw badRequest('invalid_tool', 'Unknown reading tool for this source.')
  const record = contentRecord(ctx, account, ref, true)
  const args = toolArguments(raw), budget = { chars: 0, signal: new AbortController().signal }
  if (ref.kind === 'course') return JSON.parse(runCourseReadingTool(await readCourse(ctx, account, ref, true), name, args, budget, []))
  const row = ctx.db.prepare('SELECT pages,sections,status,error FROM document_versions WHERE document_id=? AND version=?')
    .get(ref.id, ref.version) as { pages: number; sections: string; status: string; error: string | null }
  const source = (page: number) => `${record.title} · page ${page}`
  const status = { status: row.status, indexing: row.status === 'indexing', ...(row.error ? { error: row.error } : {}) }
  const result = (value: object) => JSON.parse(boundedResult({ ...status, ...value }, budget))
  if (name === 'list_document_sections') {
    const start = nonnegativeInteger(args.cursor), all = JSON.parse(row.sections) as unknown[]
    return result({ sections: all.slice(start, start + 25), pages: row.pages, nextCursor: start + 25 < all.length ? start + 25 : null })
  }
  if (name === 'search_document') {
    const query = searchQuery(args.query), cursor = nonnegativeInteger(args.cursor)
    const words = query.toLocaleLowerCase().split(/\s+/)
    const clauses = words.map(() => 'instr(lower(text),?)>0').join(' AND ')
    const matches = ctx.db.prepare(`SELECT page,text FROM document_text WHERE document_id=? AND version=? AND ${clauses} ORDER BY page LIMIT 9 OFFSET ?`)
      .all(ref.id, ref.version, ...words, cursor) as { page: number; text: string }[]
    const hits = matches.slice(0, 8).map(p => { const at = Math.max(0, p.text.toLocaleLowerCase().indexOf(words[0]!) - 80); return { page: p.page, source: source(p.page), excerpt: p.text.slice(at, at + 600) } })
    return result({ hits, nextCursor: matches.length > 8 ? cursor + 8 : null })
  }
  const start = nonnegativeInteger(args.start_page), count = nonnegativeInteger(args.count), offset = nonnegativeInteger(args.offset)
  if (start < 1 || start > row.pages || count < 1 || count > 3) throw badRequest('invalid_pages', 'Read between one and three valid pages.')
  const pages: { page: number; source: string; text?: string; unavailable?: string; notice?: string }[] = []
  let remaining = 6500, nextPage: number | null = null, nextOffset: number | null = null
  for (let page = start; page < Math.min(start + count, row.pages + 1); page++) {
    const saved = ctx.db.prepare('SELECT text FROM document_text WHERE document_id=? AND version=? AND page=?').get(ref.id, ref.version, page) as { text: string } | undefined
    if (!saved?.text) { pages.push({ page, source: source(page), unavailable: !saved ? 'Page text is not indexed yet.' : 'No extractable text; this page may need OCR.' }); continue }
    const begin = page === start ? offset : 0, text = saved.text.slice(begin, begin + remaining)
    pages.push({ page, source: source(page), text, ...(saved.text.length >= MAX_PAGE_TEXT ? { notice: 'This unusually dense page may have been truncated during indexing.' } : {}) })
    remaining -= text.length
    if (begin + text.length < saved.text.length) { nextPage = page; nextOffset = begin + text.length; break }
    if (remaining <= 0 && page + 1 < Math.min(start + count, row.pages + 1)) { nextPage = page + 1; nextOffset = 0; break }
  }
  return result({ pages, nextPage, nextOffset })
}
