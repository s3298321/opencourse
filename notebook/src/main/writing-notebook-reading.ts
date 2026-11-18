import type { WritingNotebook, WritingNotebookPage } from '../core/writing-notebooks/types'
import { findPageNode, pageTitle } from '../core/writing-notebooks/tree'
import type { ReadingSource } from '../core/documents/types'
import { boundedResult, nonnegativeInteger, searchQuery, toolArguments, type RetrievalBudget } from '../core/reading/tools'
import { getWritingPage } from './writing-notebooks'
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
  void notebook.association
  return notebookTools
}
export function runWritingReadingTool(notebook: WritingNotebook, pages: WritingNotebookPage[], name: string, raw: unknown, budget: RetrievalBudget, sources: ReadingSource[]): string {
  const args = toolArguments(raw)
  // A page's title is its file name; the tree locates the page's path by id.
  const titleOf = (pageId: string): string => { const node = findPageNode(notebook.tree ?? [], pageId); return node ? pageTitle(node.path) : '' }
  const record = (source: ReadingSource) => { if (!sources.some(s => JSON.stringify(s) === JSON.stringify(source))) sources.push(source); return source.title }
  const pageSource = (page: WritingNotebookPage) => record({ kind: 'writing-notebook', notebookId: notebook.id, pageId: page.id, title: `${notebook.title} · ${titleOf(page.id)}` })
  if (name === 'list_notebook_pages') {
    const start = nonnegativeInteger(args.cursor), items = pages.slice(start, start + 30).map(p => ({ id: p.id, title: titleOf(p.id), revision: p.revision }))
    return boundedResult({ pages: items, nextCursor: start + items.length < pages.length ? start + items.length : null }, budget)
  }
  if (name === 'search_notebook') {
    const words = searchQuery(args.query).toLowerCase().split(/\s+/), start = nonnegativeInteger(args.cursor)
    const all = pages.filter(p => words.every(w => `${titleOf(p.id)}\n${p.markdown}`.toLowerCase().includes(w)))
    return boundedResult({ hits: all.slice(start, start + 8).map(p => { const offset = Math.max(0, p.markdown.toLowerCase().indexOf(words[0]!) - 80); return { pageId: p.id, source: pageSource(p), excerpt: p.markdown.slice(offset, offset + 600) } }), nextCursor: start + 8 < all.length ? start + 8 : null }, budget)
  }
  if (name === 'read_notebook_page') {
    const page = pages.find(p => p.id === args.page_id), offset = nonnegativeInteger(args.offset)
    if (!page) throw new Error('This page is not in the notebook snapshot.')
    const text = page.markdown.slice(offset, offset + 6500)
    return boundedResult({ source: pageSource(page), text, revision: page.revision, nextOffset: offset + text.length < page.markdown.length ? offset + text.length : null }, budget)
  }
  throw new Error('This retrieval tool is not available to this notebook.')
}
