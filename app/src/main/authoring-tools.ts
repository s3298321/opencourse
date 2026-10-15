import { downloadImage, validateImage } from './image-import'
import { imageCreditsByPath, parseImageAttribution } from '../core/image-attribution'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { authoringManifest, findRef, parseAuthoringManifest } from '../core/authoring/document'
import { copyElement, deleteElement, locateElement } from '../core/course-editor'
import { courseNodes, currentFormat, newDraftRef } from '../core/course-document'
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
function requiredString(value: unknown, name: string, limit = 1000): string {
  if (typeof value !== 'string' || !value || value.length > limit) throw new Error(`Invalid ${name}.`)
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
        const text = readFileSync(join(specResourcesDir(), args.section === 'schema' ? 'course-schema.json' : 'course-format.md'), 'utf8')
        if (args.topic !== undefined && typeof args.topic !== 'string') throw new Error('Use a section heading or schema key.')
        if (args.section === 'schema') {
          const schema = JSON.parse(text) as Record<string, unknown>
          if (args.topic === undefined && args.offset === undefined) result = { sections: Object.keys(schema), note: 'Supply topic to read a schema key, or offset to read the entire schema.' }
          else if (args.topic !== undefined) {
            if (!Object.hasOwn(schema, args.topic as string)) throw new Error('Unknown schema key.')
            result = page(JSON.stringify(schema[args.topic as string]), args.offset)
          } else result = page(text, args.offset)
        } else {
          const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)]
          if (args.topic === undefined && args.offset === undefined) result = { sections: headings.map(h => h[1]), note: 'Supply topic to read a section, or offset to read the entire format.' }
          else if (args.topic !== undefined) {
            const matches = headings.filter(h => h[1]!.toLowerCase().includes(String(args.topic).toLowerCase()))
            if (matches.length !== 1) throw new Error('Choose a unique heading from the format sections.')
            const heading = matches[0]!, at = headings.indexOf(heading), level = heading[0].indexOf(' ')
            const end = headings.slice(at + 1).find(h => h[0].indexOf(' ') <= level)?.index ?? text.length
            result = page(text.slice(heading.index, end), args.offset)
          } else result = page(text, args.offset)
        }
        break
      }
      case 'list_course_elements': {
        const cursor = args.cursor ?? 0
        if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor.')
        if (args.draft_version !== undefined && args.draft_version !== draft.draftVersion) throw new Error('The draft changed; restart listing at cursor 0.')
        const nodes = courseNodes(previous)
        if (args.parent_ref !== undefined && !nodes.some(n => n.id === args.parent_ref)) throw new Error('That parent ref no longer exists.')
        const all = nodes.filter(n => args.parent_ref === undefined || n.parentId === args.parent_ref)
        const elements = all.slice(cursor, cursor + 20).map(n => ({ ref: n.id, parent: n.parentId, kind: n.kind, label: n.label.slice(0, 160) }))
        result = { draftVersion: draft.draftVersion, elements, nextCursor: cursor + elements.length < all.length ? cursor + elements.length : null }
        break
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
          if (element.type === 'image' && fields.src !== undefined && fields.src !== element.src && !('attribution' in fields)) delete element.attribution
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
        const credits = imageCreditsByPath(previous)
        result = { attachments: document.attachments.slice(start, start + 30).map(a => ({ ...a, ...(credits.has(a.entry) ? { attribution: credits.get(a.entry) } : {}) })), nextOffset: start + 30 < document.attachments.length ? start + 30 : null }; break
      }
      case 'read_asset': {
        const path = requiredString(args.path, 'path')
        if (!document.attachments.some(a => a.files.includes(path))) throw new Error('That asset is not registered to this course.')
        const file = resolveInside(packageDirectory(courseId), path)
        if (!file || !statSync(file).isFile() || statSync(file).size > 1024 * 1024 || !/\.(html?|css|js|mjs|json|svg|md|txt|map)$/i.test(path)) throw new Error('Only text assets up to 1 MiB can be read.')
        result = page(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)), args.offset); break
      }
      case 'import_image': {
        const imageUrl = requiredString(args.image_url, 'image_url', 2048)
        const attribution = parseImageAttribution(args.attribution)
        if (!attribution.license) throw new Error('Verify reusable terms on the original source and supply the license or public-domain designation before importing.')
        const bytes = await downloadImage(imageUrl, signal)
        signal.throwIfAborted()
        assertAuthoringWritable(courseId, token)
        const extension = await validateImage(bytes, signal)
        const staging = mkdtempSync(join(tmpdir(), 'opencourse-image-'))
        try {
          const file = join(staging, `image.${extension}`)
          writeFileSync(file, bytes, { flag: 'wx' })
          signal.throwIfAborted()
          const upload = await uploadCourseAttachmentPath(courseId, file, 'image', token, undefined, { attribution, image_url: imageUrl })
          result = upload.attachment
          authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId))
        } finally { rmSync(staging, { recursive: true, force: true }) }
        break
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
      const previousCredits = imageCreditsByPath(previous)
      for (const module of next.modules) if (module.type !== 'project') for (const lesson of module.lessons) for (const block of lesson.blocks) {
        if (block.type === 'image') {
          const credit = previousCredits.get(block.src) ?? document.attachments.find(a => a.entry === block.src)?.attribution
          const old = block.nodeId ? locateElement(previous, block.nodeId)?.element : undefined
          if (!block.attribution && credit && (!old || !('src' in old) || old.src !== block.src)) block.attribution = structuredClone(credit)
          if (block.attribution) { parseImageAttribution(block.attribution); Object.assign(next, currentFormat(next)) }
        }
      }
      if (signal.aborted) throw new Error('Authoring stopped.')
      const saved = saveDraft(courseId, next, document.revision, draft.draftVersion, token)
      if ('status' in saved) throw new Error('The draft changed. Read it again before applying this edit.')
      authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId))
      const oldRefs = new Set(courseNodes(previous).map(n => n.id))
      const created = courseNodes(next).filter(n => !oldRefs.has(n.id))
      result = { ...(result as object ?? {}), operation: name, draftVersion: saved.draftVersion,
        ...(typeof args.ref === 'string' ? { affectedRef: args.ref } : {}),
        ...(typeof args.parent_ref === 'string' ? { parentRef: args.parent_ref } : {}),
        created: created.slice(0, 10).map(n => ({ ref: n.id, parent: n.parentId, kind: n.kind })),
        createdCount: created.length,
        ...(created.length > 10 ? { more: 'Use list_course_elements to discover remaining refs.' } : {}) }
    }
    return JSON.stringify({ ok: true, result })
  } catch (error) { return JSON.stringify({ ok: false, error: (error as Error).message }) }
}
