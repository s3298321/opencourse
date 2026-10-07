import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { authoringManifest, findRef, parseAuthoringManifest } from '../core/authoring/document'
import { copyElement, deleteElement, locateElement } from '../core/course-editor'
import { currentFormat, newDraftRef } from '../core/course-document'
import { resolveInside } from '../core/safepath'
import { classifyEntry } from '../core/import'
import type { CourseManifest, Lesson } from '../core/types'
import { getAuthoringCourse, previewCourseSave, saveDraft, uploadCourseAttachmentPath } from './course-authoring'
import { packageDirectory } from './course-store'
import { specResourcesDir } from './paths'
import { authoringEvents, assertAuthoringWritable } from './authoring-state'

const PAGE = 24000
function page(text: string, offset: unknown) {
  const start = offset === undefined ? 0 : offset
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) throw new Error('Invalid offset.')
  return { text: text.slice(start, start + PAGE), offset: start, nextOffset: start + PAGE < text.length ? start + PAGE : null, total: text.length }
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 1000) throw new Error(`Invalid ${name}.`)
  return value
}
function index(value: unknown, length: number): number {
  if (value === undefined) return length
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > length) throw new Error('Invalid destination index.')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.')
  return value as Record<string, unknown>
}
export async function runAuthoringTool(courseId: string, name: string, raw: unknown, token: symbol, signal: AbortSignal): Promise<string> {
  try {
    if (signal.aborted) throw new Error('Authoring stopped.')
    assertAuthoringWritable(courseId, token)
    const args = record(raw), { document, draft } = getAuthoringCourse(courseId)
    const previous = draft.manifest
    const authored = authoringManifest(previous)
    let next: CourseManifest | undefined
    let result: unknown
    switch (name) {
      case 'get_course_format': {
        if (args.section !== undefined && args.section !== 'format' && args.section !== 'schema') throw new Error('Choose format or schema.')
        result = page(readFileSync(join(specResourcesDir(), args.section === 'schema' ? 'course-schema.json' : 'course-format.md'), 'utf8'), args.offset); break
      }
      case 'read_course': {
        const value = args.ref === undefined ? args.full === true ? authored : { ...authored, modules: authored.modules.map(m => ({ ref: m.nodeId ?? (m as unknown as { ref: string }).ref, slug: m.slug, title: m.title, type: m.type ?? 'lessons', ...(m.type === 'project' ? {} : { lessons: m.lessons.map(l => ({ ref: (l as unknown as { ref: string }).ref, slug: l.slug, title: l.title, blocks: l.blocks.map(b => ({ ref: (b as unknown as { ref: string }).ref, slug: b.slug, type: b.type })), flashcards: l.flashcards?.map(card => ({ ref: (card as unknown as { ref: string }).ref, id: card.id, question: card.question, kind: 'flashcard' })) })) }) })) } : findRef(authored, requiredString(args.ref, 'ref'))
        if (!value) throw new Error('That ref no longer exists. Read the latest course outline.')
        const serialized = JSON.stringify(value)
        result = serialized.length <= PAGE && args.offset === undefined ? { draftVersion: draft.draftVersion, course: value } : { draftVersion: draft.draftVersion, ...page(serialized, args.offset) }; break
      }
      case 'set_course': next = parseAuthoringManifest(args.course, previous); break
      case 'update_element': {
        const fields = record(args.fields)
        if ('ref' in fields || 'nodeId' in fields) throw new Error('An edit cannot change an element identity.')
        if (args.ref === undefined) Object.assign(authored, fields)
        else {
          const element = findRef(authored, requiredString(args.ref, 'ref'))
          if (!element) throw new Error('That ref no longer exists.')
          Object.assign(element, fields)
        }
        next = parseAuthoringManifest(authored, previous); break
      }
      case 'add_element': {
        const element = record(args.element)
        let siblings: unknown[] = authored.modules
        if (args.parent_ref !== undefined) {
          const parent = findRef(authored, requiredString(args.parent_ref, 'parent_ref'))
          if (!parent) throw new Error('That parent no longer exists.')
          if (args.collection !== undefined && !['blocks', 'flashcards'].includes(String(args.collection))) throw new Error('Choose blocks or flashcards.')
          if (args.collection === 'flashcards') {
            if (!Array.isArray(parent.blocks)) throw new Error('Flashcards require a lesson parent.')
            siblings = (parent.flashcards ??= []) as unknown[]
            Object.assign(authored, currentFormat(authored))
          } else siblings = Array.isArray(parent.lessons) ? parent.lessons : Array.isArray(parent.blocks) ? parent.blocks : []
          if (!Array.isArray(parent.lessons) && !Array.isArray(parent.blocks)) throw new Error('Elements can be added only under lesson modules or lessons.')
        }
        siblings.splice(index(args.index, siblings.length), 0, element)
        next = parseAuthoringManifest(authored, previous); break
      }
      case 'delete_element': {
        const ref = requiredString(args.ref, 'ref')
        if (!locateElement(previous, ref)) throw new Error('That outline element no longer exists.')
        next = deleteElement(previous, ref); break
      }
      case 'duplicate_element': {
        const ref = requiredString(args.ref, 'ref')
        if (!locateElement(previous, ref)) throw new Error('That outline element no longer exists.')
        const copied = copyElement(previous, ref, newDraftRef)
        next = copied.manifest; result = { ref: copied.id }; break
      }
      case 'move_element': {
        next = structuredClone(previous)
        const location = locateElement(next, requiredString(args.ref, 'ref'))
        if (!location) throw new Error('That outline element no longer exists.')
        let siblings = next.modules as unknown[]
        if (args.parent_ref !== undefined) {
          const parent = locateElement(next, requiredString(args.parent_ref, 'parent_ref'))
          if (!parent || !(location.kind === 'lesson' && parent.kind === 'module' && 'lessons' in parent.element && parent.element.type !== 'project' || ['block', 'flashcard'].includes(location.kind) && parent.kind === 'lesson')) throw new Error('Invalid destination for this element type.')
          if (location.kind === 'flashcard') {
            const lesson = parent.element as Lesson
            if (parent.element.nodeId !== location.parentId) throw new Error('Flashcards are bound to their lesson. Create a new card in the other lesson and delete this one.')
            siblings = lesson.flashcards ??= []
          } else siblings = 'lessons' in parent.element ? parent.element.lessons! : (parent.element as { blocks: unknown[] }).blocks
        } else if (location.kind !== 'module') throw new Error('A lesson or block requires a parent_ref.')
        const same = siblings === location.siblings
        const destination = index(args.index, siblings.length - (same ? 1 : 0))
        const [element] = location.siblings.splice(location.index, 1)
        siblings.splice(destination, 0, element); break
      }
      case 'validate_course': result = previewCourseSave(courseId); break
      case 'list_assets': {
        const start = args.offset ?? 0
        if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) throw new Error('Invalid offset.')
        result = { attachments: document.attachments.slice(start, start + 30), nextOffset: start + 30 < document.attachments.length ? start + 30 : null }; break
      }
      case 'read_asset': {
        const path = requiredString(args.path, 'path')
        if (!document.attachments.some(a => a.files.includes(path))) throw new Error('That asset is not registered to this course.')
        const file = resolveInside(packageDirectory(courseId), path)
        if (!file || !statSync(file).isFile() || statSync(file).size > 1024 * 1024 || !/\.(html?|css|js|mjs|json|svg|md|txt|map)$/i.test(path)) throw new Error('Only text assets up to 1 MiB can be read.')
        result = page(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)), args.offset); break
      }
      case 'write_asset_bundle': {
        const kind = args.kind
        if (kind !== 'image' && kind !== 'visualization') throw new Error('Choose image or visualization.')
        const entry = requiredString(args.entry, 'entry')
        if (!Array.isArray(args.files) || !args.files.length || args.files.length > 100) throw new Error('Supply 1–100 text files.')
        const paths = new Set<string>(), files: { path: string; content: string }[] = []
        let bytes = 0
        for (const value of args.files) {
          const file = record(value), path = requiredString(file.path, 'path')
          if (typeof file.content !== 'string' || file.content.includes('\0')) throw new Error('Asset content must be UTF-8 text without null bytes.')
          bytes += Buffer.byteLength(file.content)
          const verdict = classifyEntry(path, { size: Buffer.byteLength(file.content), isSymlink: false })
          if (verdict.kind !== 'file' || !['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.txt', '.md'].includes(extname(path).toLowerCase())) throw new Error('Invalid text asset path or extension.')
          if (paths.has(path) || [...paths].some(p => p.startsWith(`${path}/`) || path.startsWith(`${p}/`))) throw new Error('Duplicate or conflicting asset paths.')
          paths.add(path); files.push({ path, content: file.content })
        }
        if (bytes > 1024 * 1024) throw new Error('A generated bundle may contain at most 1 MiB of text.')
        if (!paths.has(entry) || (kind === 'image' ? files.length !== 1 || !entry.endsWith('.svg') : !/\.html?$/i.test(entry))) throw new Error('Supply the SVG or HTML entry file.')
        const staging = mkdtempSync(join(tmpdir(), 'opencourse-generated-'))
        try {
          for (const file of files) { const path = join(staging, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content, { flag: 'wx' }) }
          const upload = await uploadCourseAttachmentPath(courseId, kind === 'image' ? join(staging, entry) : staging, kind, token, entry)
          if (signal.aborted) throw new Error('Authoring stopped.')
          assertAuthoringWritable(courseId, token)
          result = upload.attachment
          authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId))
        } finally { rmSync(staging, { recursive: true, force: true }) }
        break
      }
      default: throw new Error(`Unknown authoring tool: ${name}`)
    }
    if (next) {
      if (signal.aborted) throw new Error('Authoring stopped.')
      const saved = saveDraft(courseId, next, document.revision, draft.draftVersion, token)
      if ('status' in saved) throw new Error('The draft changed. Read it again before applying this edit.')
      authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId))
      result = { ...(result as object ?? {}), draftVersion: saved.draftVersion, outline: JSON.parse(await runAuthoringTool(courseId, 'read_course', {}, token, signal)) }
    }
    return JSON.stringify({ ok: true, result })
  } catch (error) { return JSON.stringify({ ok: false, error: (error as Error).message }) }
}
