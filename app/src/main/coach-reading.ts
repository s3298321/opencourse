import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COACH_READING_NAMES } from '../core/coach/reading'
import { boundedResult, COURSE_TOOLS, DOCUMENT_TOOLS, nonnegativeInteger, searchQuery, toolArguments } from '../core/reading/tools'
import { readNotebookCells } from '../core/notebook/reading'
import type { LearningState } from '../core/learning/types'
import { requireProject } from './coach'
import { getCourse, listCourses } from './courses'
import { runCourseReadingTool } from './course-reading'
import { runDocumentReadingTool } from './document-reading'
import { getWritingNotebook, getWritingPage, listWritingNotebooks } from './writing-notebooks'
import { listDocuments } from './documents'
import { currentUserId, requireUser } from './users'
import { notebookDirectory } from './notebooks'
import { readNotebook } from './notebook-store'
import { listConnections } from './servers'
import { searchCatalog } from './catalog'
import { searchDocuments } from './document-catalog'
import { learningRequest } from './learning'

function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Use an ID returned by app context or discovery.')
  return value
}
function localSource(id: string) { return { id, server_id: null, version: null } }
function savedNotebook(courseId: string) {
  if (!getCourse(courseId)) throw new Error('This course is unavailable in the learner’s library.')
  return readNotebook(join(notebookDirectory(requireUser(), courseId), 'notebook.json'))
}
function pythonNotebooks() {
  return listCourses().filter(c => !c.error && existsSync(join(notebookDirectory(requireUser(), c.courseId), 'notebook.json')))
}

/** All access is within the session owner's current library/account; no model-supplied paths or URLs. */
export async function runCoachReadingTool(projectId: string, name: string, raw: unknown): Promise<string> {
  requireProject(projectId)
  if (!COACH_READING_NAMES.includes(name)) throw new Error('Unknown coach reading tool.')
  const owner = requireUser(), args = toolArguments(raw)
  const budget = { chars: 0, signal: new AbortController().signal }
  const result = (value: unknown) => {
    if (owner !== currentUserId()) throw new Error('The learner changed. Start a new request.')
    return boundedResult(value, budget)
  }
  if (name === 'get_app_context') {
    const { readAppContext } = await import('./coach-context')
    return result(await readAppContext(nonnegativeInteger(args.cursor)))
  }
  if (name === 'list_learning_sources') {
    const start = nonnegativeInteger(args.cursor)
    const sources = [{ server_id: null, title: 'Local library' }, ...listConnections().map(s => ({ server_id: s.id, title: s.name, signedIn: !!s.account }))]
    return result({ sources: sources.slice(start, start + 20), nextCursor: start + 20 < sources.length ? start + 20 : null })
  }
  if (name === 'list_learning_content') {
    const start = nonnegativeInteger(args.cursor)
    if (typeof args.query !== 'string' || args.query.length > 300) throw new Error('Use a query of at most 300 characters, or an empty string.')
    const query = args.query.trim()
    if (args.server_id === null) {
      const all = [...listCourses().map(c => ({ kind: 'course', title: c.title, source: localSource(c.courseId), ...(c.error ? { unavailable: c.error } : {}) })),
        ...listDocuments().map(d => ({ kind: 'document', title: d.title, source: localSource(d.id) }))]
        .filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      return result({ items: all.slice(start, start + 15), nextCursor: start + 15 < all.length ? start + 15 : null })
    }
    const serverId = id(args.server_id)
    if (args.collection === 'library') {
      const response = await learningRequest<{ items: LearningState[] }>(serverId, '/me/learning')
      const items = response.items.map(item => item.enrollment).filter(e => e.active && e.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      return result({ items: items.slice(start, start + 15).map(e => ({ kind: e.kind, title: e.title, source: { id: e.id, server_id: serverId, version: e.version } })), nextCursor: start + 15 < items.length ? start + 15 : null })
    }
    if (args.collection !== 'catalog') throw new Error('Choose library or catalog.')
    // Pack catalog page and within-page offset in a numeric continuation cursor.
    const catalogPage = Math.floor(start / 1000), offset = start % 1000
    if (catalogPage >= 1000) throw new Error('Narrow the catalog search.')
    const [courses, documents] = await Promise.allSettled([searchCatalog(serverId, { q: query, page: catalogPage + 1 }), searchDocuments(serverId, { q: query, page: catalogPage + 1 })])
    const items = [...(courses.status === 'fulfilled' ? courses.value.courses.map(c => ({ kind: 'course', title: c.title.slice(0, 300), source: { id: c.id, server_id: serverId, version: c.version } })) : []),
      ...(documents.status === 'fulfilled' ? documents.value.documents.map(d => ({ kind: 'document', title: d.title.slice(0, 300), source: { id: d.id, server_id: serverId, version: d.version } })) : [])]
    const more = (courses.status === 'fulfilled' && (catalogPage + 1) * courses.value.pageSize < courses.value.total) || (documents.status === 'fulfilled' && (catalogPage + 1) * documents.value.pageSize < documents.value.total)
    const errors = [courses, documents].flatMap((r, i) => r.status === 'rejected' ? [{ kind: i === 0 ? 'course' : 'document', error: String(r.reason instanceof Error ? r.reason.message : 'Catalog unavailable').slice(0, 500) }] : [])
    return result({ items: items.slice(offset, offset + 15), errors, nextCursor: offset + 15 < items.length ? start + 15 : more ? (catalogPage + 1) * 1000 : null })
  }
  if (name === 'list_notebooks') {
    const start = nonnegativeInteger(args.cursor)
    const all = [...listWritingNotebooks().map(n => ({ kind: 'writing-notebook', notebookId: n.id, title: n.title })),
      ...pythonNotebooks().map(c => ({ kind: 'notebook', courseId: c.courseId, title: `${c.title} · Python notebook` }))]
    return result({ notebooks: all.slice(start, start + 20), nextCursor: start + 20 < all.length ? start + 20 : null })
  }
  if (name === 'search_notebooks') {
    const words = searchQuery(args.query).toLocaleLowerCase().split(/\s+/), start = nonnegativeInteger(args.cursor)
    const pages = listWritingNotebooks().flatMap(n => n.pages.map(p => ({ notebookId: n.id, pageId: p.id, source: `${n.title} · ${p.title}` })))
    // Read only the current batch of writing pages. Python notebooks are separate batches (one notebook per cursor).
    const python = pythonNotebooks(), units = pages.length + python.length
    if (start < pages.length) {
      const end = Math.min(start + 12, pages.length)
      const hits = pages.slice(start, end).flatMap(p => {
        const saved = getWritingPage(p.notebookId, p.pageId), text = `${p.source}\n${saved.markdown}`, lower = text.toLocaleLowerCase()
        if (!words.every(word => lower.includes(word))) return []
        const offset = Math.max(0, lower.indexOf(words[0]!) - 80)
        return [{ ...p, revision: saved.revision, excerpt: text.slice(offset, offset + 350) }]
      })
      return result({ state: 'saved text only', hits, nextCursor: end < units ? end : null })
    }
    const course = python[start - pages.length]
    if (!course) return result({ state: 'saved text only', hits: [], nextCursor: null })
    const notebook = savedNotebook(course.courseId)
    const hits = notebook.cells.flatMap((cell, cursor) => {
      const text = `${cell.content}\n${cell.execution?.outputs.map(o => o.text).join('') ?? ''}`, lower = text.toLocaleLowerCase()
      if (!words.every(word => lower.includes(word))) return []
      const offset = Math.max(0, lower.indexOf(words[0]!) - 80)
      return [{ courseId: course.courseId, cellId: cell.id, cursor, source: `${course.title} · cell ${cursor + 1}`, excerpt: text.slice(offset, offset + 350) }]
    })
    return result({ state: 'saved text only', hits: hits.slice(0, 15), truncated: hits.length > 15, notice: hits.length > 15 ? 'Narrow the search or read cells to inspect additional matches.' : undefined, nextCursor: start + 1 < units ? start + 1 : null })
  }
  if (name === 'read_notebook_cells') {
    const courseId = id(args.course_id); nonnegativeInteger(args.cursor); nonnegativeInteger(args.offset)
    if (!getCourse(courseId)) throw new Error('This course is unavailable.')
    const { readOpenNotebook } = await import('./coach-context')
    const open = await readOpenNotebook(name, args)
    return result(open ?? { ...JSON.parse(readNotebookCells(savedNotebook(courseId), args, budget)), state: 'saved text' })
  }
  if (name === 'list_notebook_pages' || name === 'read_notebook_page') {
    const notebook = getWritingNotebook(id(args.notebook_id))
    if (name === 'list_notebook_pages') {
      const start = nonnegativeInteger(args.cursor)
      return result({ pages: notebook.pages.slice(start, start + 25), nextCursor: start + 25 < notebook.pages.length ? start + 25 : null })
    }
    const pageId = id(args.page_id), offset = nonnegativeInteger(args.offset)
    if (!notebook.pages.some(p => p.id === pageId)) throw new Error('This page does not belong to the notebook.')
    const { readOpenNotebook } = await import('./coach-context')
    const open = await readOpenNotebook(name, args)
    if (open !== undefined) return result(open)
    const saved = getWritingPage(notebook.id, pageId), text = saved.markdown.slice(offset, offset + 6500)
    return result({ source: `${notebook.title} · ${saved.title}`, text, revision: saved.revision, state: 'saved text', nextOffset: offset + text.length < saved.markdown.length ? offset + text.length : null })
  }
  const kind = COURSE_TOOLS.some(t => t.name === name) ? 'course' : DOCUMENT_TOOLS.some(t => t.name === name) ? 'document' : null
  if (!kind) throw new Error('Unknown reading tool.')
  const source = toolArguments(args.source), sourceId = id(source.id)
  if (source.server_id !== null) {
    const serverId = id(source.server_id), version = id(source.version)
    const response = await learningRequest(serverId, `/learn/${kind}/${encodeURIComponent(sourceId)}/${encodeURIComponent(version)}/read`, 'POST', { name, args })
    return result(response)
  }
  if (kind === 'course') {
    const course = getCourse(sourceId)
    if (!course) throw new Error('This course is unavailable locally. Discover server content with list_learning_content.')
    return runCourseReadingTool(course, name, args, budget, [])
  }
  return runDocumentReadingTool(sourceId, name, args, budget, [])
}
