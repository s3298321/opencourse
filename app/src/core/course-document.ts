import type { CourseManifest, CourseProgress, Module } from './types'
import { DEFAULT_COURSE_VERSION } from './catalog/semver'
import type { CourseOrigin } from './catalog/origin'

/** The format version the app writes. Every save and export upgrades to it. */
export const CURRENT_SCHEMA_VERSION = '1.5'

export interface Attachment {
  id: string
  entry: string
  files: string[]
  managed: boolean
}
export interface CourseDocument {
  version: 1
  courseId: string
  revision: number
  manifest: CourseManifest | null
  attachments: Attachment[]
  legacySlug?: string
  recoveryNotes?: string[]
  error?: string
  /** Last save's temporary-reference mapping, retained for editor recovery. */
  nodeRefMap?: Record<string, string>
  /** Absent for a local course; where a server course came from (core/catalog/origin.ts). */
  origin?: CourseOrigin
}
export interface CourseDraft {
  courseId: string
  baseRevision: number
  draftVersion: number
  manifest: CourseManifest
  /** Something differs from the saved course: an edit, or an upload not yet saved. */
  dirty?: boolean
}
export interface AuthoringCourse { document: CourseDocument; draft: CourseDraft }
export interface CourseNode { id: string; parentId: string | null; kind: string; label: string }
export interface SavePreview { errors: string[]; deleted: CourseNode[]; messages: number; workspaces: number }
export type SaveCourseResult =
  | { status: 'ok'; revision: number; nodeRefMap?: Record<string, string>; copiedTo?: string }
  | { status: 'conflict' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'confirmation-required'; preview: SavePreview }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const DRAFT_REF = /^draft:[a-f0-9]{32}$/
export function newDraftRef(): string {
  return `draft:${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`
}
export function materializeDraft(manifest: CourseManifest, uuid: () => string): { manifest: CourseManifest; nodeRefMap: Record<string, string> } {
  const copy = structuredClone(manifest), nodeRefMap: Record<string, string> = {}
  visitNodes(copy, node => {
    if (DRAFT_REF.test(String(node.nodeId))) {
      const ref = String(node.nodeId)
      node.nodeId = nodeRefMap[ref] ??= uuid()
    }
  })
  return { manifest: copy, nodeRefMap }
}

/** Walk authored entities, never runtime settings or scalar list entries. */
export function visitNodes(manifest: CourseManifest, visit: (node: Record<string, unknown>, parent: string | null, kind: string) => void): void {
  const walk = (node: object, parent: string | null, kind: string): void => {
    const n = node as Record<string, unknown>
    visit(n, parent, kind)
    const id = String(n.nodeId ?? '')
    for (const [key, childKind] of [
      ['modules', 'module'], ['lessons', 'lesson'], ['blocks', 'block'], ['flashcards', 'flashcard'], ['options', 'option'],
      ['requirements', 'requirement'], ['deliverables', 'deliverable'], ['extra_files', 'support-file'], ['starter_files', 'starter-file']
    ]) {
      if (Array.isArray(n[key])) for (const child of n[key] as object[]) walk(child, id || parent, childKind)
    }
    if (n.project && typeof n.project === 'object') walk(n.project, id, 'project-definition')
  }
  for (const mod of manifest.modules) walk(mod, null, 'module')
}

/**
 * Fresh local identities for a course that arrived as a local archive. Any
 * server `uid`s it carries are dropped: a ZIP is a local course, whatever it
 * was exported or downloaded from.
 */
export function identifyManifest(manifest: CourseManifest, uuid: () => string): CourseManifest {
  const copy = structuredClone(manifest)
  delete copy.uid
  visitNodes(copy, (node) => { node.nodeId = uuid(); delete node.uid })
  return copy
}

export function courseNodes(manifest: CourseManifest | null): CourseNode[] {
  const nodes: CourseNode[] = []
  if (manifest) visitNodes(manifest, (node, parentId, kind) => nodes.push({
    id: String(node.nodeId), parentId, kind: kind === 'module' ? node.type === 'project' ? 'project' : 'module' : String(node.type ?? kind),
    label: String(kind === 'block' ? node.slug ?? node.type : node.title ?? node.question ?? node.path ?? node.text ?? node.description ?? kind)
  }))
  return nodes
}

export function validateIdentities(manifest: CourseManifest, previous?: CourseManifest | null, allowDraft = false): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const old = new Map(courseNodes(previous ?? null).map((n) => [n.id, n]))
  for (const node of courseNodes(manifest)) {
    if (!UUID.test(node.id) && !(allowDraft && DRAFT_REF.test(node.id))) errors.push(`${node.label}: invalid local identity`)
    if (seen.has(node.id)) errors.push(`${node.label}: duplicate local identity`)
    if (old.has(node.id) && old.get(node.id)!.kind !== node.kind) errors.push(`${node.label}: changing type requires a new identity`)
    if (node.kind === 'flashcard' && old.has(node.id) && old.get(node.id)!.parentId !== node.parentId) errors.push(`${node.label}: flashcards are bound to their lesson; create a new card in the other lesson and delete this one`)
    seen.add(node.id)
  }
  for (const [m, module] of manifest.modules.entries()) if (module.type !== 'project') {
    for (const [l, lesson] of module.lessons.entries()) for (const [b, block] of lesson.blocks.entries()) {
      if (block.slug === undefined) errors.push(`/modules/${m}/lessons/${l}/blocks/${b}/slug: a block slug is required`)
    }
  }
  return errors
}

/**
 * Fresh identities for every node of a working copy - saved IDs, server uids
 * and draft refs alike - with the map from each old one to its new one, so
 * whatever pointed at an element (an assistant chat's target) can follow it.
 */
export function reidentifyManifest(manifest: CourseManifest, uuid: () => string): { manifest: CourseManifest; map: Record<string, string> } {
  const copy = structuredClone(manifest)
  delete copy.uid
  const map: Record<string, string> = {}
  visitNodes(copy, (node) => {
    const fresh = uuid()
    if (node.nodeId) map[String(node.nodeId)] = fresh
    node.nodeId = fresh
    delete node.uid
  })
  return { manifest: copy, map }
}

/** Portable authored fields, including block slugs; never serialize local or server identities. */
export function portableManifest(manifest: CourseManifest): CourseManifest {
  const copy = structuredClone(manifest)
  delete copy.uid
  visitNodes(copy, (node) => { delete node.nodeId; delete node.uid })
  return copy
}

/** Brings a manifest up to the format the app writes: the current schema, and a version. */
export function currentFormat(manifest: CourseManifest): CourseManifest {
  return { ...manifest, schema_version: CURRENT_SCHEMA_VERSION, version: manifest.version ?? DEFAULT_COURSE_VERSION }
}

/** Learner identifiers are local UUIDs; author identifiers remain in the document. */
export function learningManifest(manifest: CourseManifest): CourseManifest {
  const copy = structuredClone(manifest)
  visitNodes(copy, (node, _parent, kind) => {
    if (!node.nodeId) return
    if (kind === 'module' || kind === 'lesson') node.slug = node.nodeId
    if ('id' in node) node.id = node.nodeId
  })
  return copy
}

export function deletedNodes(before: CourseManifest | null, after: CourseManifest): CourseNode[] {
  const ids = new Set(courseNodes(after).map((n) => n.id))
  return courseNodes(before).filter((n) => !ids.has(n.id))
}

export function reconcileProgress(progress: CourseProgress, before: CourseManifest | null, after: CourseManifest): CourseProgress {
  const removed = new Set(deletedNodes(before, after).map((n) => n.id))
  const result = structuredClone(progress)
  result.completedLessons = result.completedLessons.filter((id) => !removed.has(id))
  for (const field of ['quizAttempts', 'exercises', 'projects'] as const) {
    for (const id of Object.keys(result[field])) if (removed.has(id)) delete result[field][id]
  }
  for (const [id, attempt] of Object.entries(result.quizAttempts)) {
    if (attempt.submitted.some((option) => removed.has(option))) delete result.quizAttempts[id]
  }
  const lessonParents = new Map(courseNodes(after).filter((n) => n.kind === 'lesson').map((n) => [n.id, n.parentId!]))
  if (result.lastLesson && removed.has(result.lastLesson.lessonId)) delete result.lastLesson
  if (result.lastLesson && lessonParents.has(result.lastLesson.lessonId)) result.lastLesson.moduleId = lessonParents.get(result.lastLesson.lessonId)!
  if (result.lastItem?.kind === 'lesson' && lessonParents.has(result.lastItem.lessonId)) result.lastItem.moduleId = lessonParents.get(result.lastItem.lessonId)!
  if (result.lastItem && removed.has(result.lastItem.kind === 'lesson' ? result.lastItem.lessonId : result.lastItem.moduleId)) delete result.lastItem
  return result
}

export function duplicateElement<T extends object>(element: T, uuid: () => string): T {
  const clone = structuredClone(element)
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const node = value as Record<string, unknown>
    if ('nodeId' in node) {
      node.nodeId = uuid()
      const suffix = String(node.nodeId).replace(/[^a-z0-9]/gi, '').slice(-12)
      if ('slug' in node) node.slug = `copy-${suffix}`
      if ('id' in node) node.id = `item-${suffix}`
    }
    Object.values(node).forEach(visit)
  }
  visit(clone)
  return clone
}

export function emptyManifest(): CourseManifest {
  return { schema_version: CURRENT_SCHEMA_VERSION, slug: 'untitled-course', title: 'Untitled course', version: DEFAULT_COURSE_VERSION, modules: [] }
}

export function findAuthoredModule(manifest: CourseManifest, moduleId: string): Module | undefined {
  return manifest.modules.find((m) => m.nodeId === moduleId)
}
