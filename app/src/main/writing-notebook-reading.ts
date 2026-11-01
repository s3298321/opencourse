import type { WritingNotebook, WritingNotebookPage } from '../core/writing-notebooks/types'
import type { ReadingSource } from '../core/documents/types'
import { boundedResult, COURSE_TOOLS, DOCUMENT_TOOLS, nonnegativeInteger, searchQuery, toolArguments, type RetrievalBudget } from '../core/reading/tools'
import { getWritingPage } from './writing-notebooks'
import { getCourse } from './courses'
import { runCourseReadingTool } from './course-reading'
import { runDocumentReadingTool } from './document-reading'
const cursor = { type: 'integer', minimum: 0 }
const string = { type: 'string', maxLength: 300 }
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: 'function', name, description, strict: true, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } })
const notebookTools = [
  tool('list_notebook_pages', 'List pages of this notebook.', { cursor }),
  tool('search_notebook', 'Search this notebook for words.', { query: string, cursor }),
  tool('read_notebook_page', 'Read one saved notebook page by its ID, in bounded chunks.', { page_id: string, offset: cursor })
]
export const notebookSnapshot = (notebook: WritingNotebook): WritingNotebookPage[] => notebook.pages.map(page => getWritingPage(notebook.id, page.id))
export function writingReadingTools(notebook: WritingNotebook) {
  return [...notebookTools, ...(notebook.association?.kind === 'course' ? COURSE_TOOLS : notebook.association?.kind === 'document' ? DOCUMENT_TOOLS : [])]
}
export function runWritingReadingTool(notebook: WritingNotebook, pages: WritingNotebookPage[], name: string, raw: unknown, budget: RetrievalBudget, sources: ReadingSource[]): string {
  const args = toolArguments(raw)
  const record = (source: ReadingSource) => { if (!sources.some(s => JSON.stringify(s) === JSON.stringify(source))) sources.push(source); return source.title }
  const pageSource = (page: WritingNotebookPage) => record({ kind: 'writing-notebook', notebookId: notebook.id, pageId: page.id, title: `${notebook.title} · ${page.title}` })
  if (name === 'list_notebook_pages') {
    const start = nonnegativeInteger(args.cursor), items = pages.slice(start, start + 30).map(p => ({ id: p.id, title: p.title, revision: p.revision }))
    return boundedResult({ pages: items, nextCursor: start + items.length < pages.length ? start + items.length : null }, budget)
  }
  if (name === 'search_notebook') {
    const words = searchQuery(args.query).toLowerCase().split(/\s+/), start = nonnegativeInteger(args.cursor)
    const all = pages.filter(p => words.every(w => `${p.title}\n${p.markdown}`.toLowerCase().includes(w)))
    return boundedResult({ hits: all.slice(start, start + 8).map(p => { const offset = Math.max(0, p.markdown.toLowerCase().indexOf(words[0]!) - 80); return { pageId: p.id, source: pageSource(p), excerpt: p.markdown.slice(offset, offset + 600) } }), nextCursor: start + 8 < all.length ? start + 8 : null }, budget)
  }
  if (name === 'read_notebook_page') {
    const page = pages.find(p => p.id === args.page_id), offset = nonnegativeInteger(args.offset)
    if (!page) throw new Error('This page is not in the notebook snapshot.')
    const text = page.markdown.slice(offset, offset + 6500)
    return boundedResult({ source: pageSource(page), text, revision: page.revision, nextOffset: offset + text.length < page.markdown.length ? offset + text.length : null }, budget)
  }
  const association = notebook.association
  if (association?.kind === 'course' && COURSE_TOOLS.some(t => t.name === name)) {
    const course = getCourse(association.id)
    if (!course) throw new Error('The associated course is unavailable locally.')
    return runCourseReadingTool(course, name, args, budget, sources)
  }
  if (association?.kind === 'document' && DOCUMENT_TOOLS.some(t => t.name === name)) return runDocumentReadingTool(association.id, name, args, budget, sources)
  throw new Error('This retrieval tool is not available to this notebook.')
}
