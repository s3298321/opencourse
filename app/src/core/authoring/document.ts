import Ajv2020 from 'ajv/dist/2020'
import { courseSchema } from '../schema'
import { courseNodes, newDraftRef, portableManifest, validateIdentities, visitNodes } from '../course-document'
import { locateElement } from '../course-editor'
import type { AuthoringTarget, CourseManifest } from '../types'

// Drafts can be incomplete, but must retain the shapes used by previews and fields.
const draftSchema = structuredClone(courseSchema) as Record<string, unknown>
function relax(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(relax); return }
  const object = value as Record<string, unknown>
  delete object.minItems; delete object.minLength
  if (object.pattern === "\\S") delete object.pattern
  Object.values(object).forEach(relax)
}
relax(draftSchema)
const validateDraft = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true }).compile(draftSchema)

/** Portable authored fields annotated with opaque references. These are never exported. */
export function authoringManifest(manifest: CourseManifest): CourseManifest {
  const result = structuredClone(manifest)
  visitNodes(result, node => { node.ref = node.nodeId; delete node.nodeId })
  return result
}
function withoutRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRefs)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'nodeId') throw new Error('Use application-supplied refs; do not supply nodeId or generate UUIDs.')
    if (key !== 'ref') result[key] = withoutRefs(child)
  }
  return result
}
export function parseAuthoringManifest(value: unknown, previous: CourseManifest): CourseManifest {
  const portable = withoutRefs(value)
  if (Buffer.byteLength(JSON.stringify(portable)) > 10 * 1024 * 1024) throw new Error('The draft exceeds 10 MiB.')
  if (!validateDraft(portable)) throw new Error(validateDraft.errors?.slice(0, 8).map(e => `${e.instancePath || '/'}: ${e.message}`).join('; ') ?? 'Invalid draft.')
  const result = structuredClone(value) as CourseManifest
  const known = new Set(courseNodes(previous).map(n => n.id)), used = new Set<string>()
  visitNodes(result, node => {
    const ref = node.ref
    if (ref !== undefined && (typeof ref !== 'string' || !known.has(ref) || used.has(ref))) throw new Error('Unknown or duplicate ref. Read the latest course before editing.')
    node.nodeId = ref ?? newDraftRef()
    used.add(String(node.nodeId)); delete node.ref
  })
  const issues = validateIdentities(result, previous, true)
  if (issues.length) throw new Error(issues.join('; '))
  return result
}
export function validateDraftShape(manifest: CourseManifest): void {
  // Reuse the same checks without replacing the draft's existing references.
  parseAuthoringManifest(authoringManifest(manifest), manifest)
}
export function authoringContext(manifest: CourseManifest, target: AuthoringTarget, draftVersion: number) {
  if (!target || typeof target !== 'object' || !['overview', 'module', 'lesson', 'project', 'block', 'flashcard'].includes(target.kind)) throw new Error('Invalid authoring target.')
  const location = target.kind === 'overview' ? undefined : locateElement(manifest, target.ref)
  if (target.kind !== 'overview' && !location) throw new Error('The selected element no longer exists. Select another element before sending.')
  const kind = location?.kind === 'module' && 'type' in location.element && location.element.type === 'project' ? 'project' : location?.kind
  if (location && target.kind !== kind) throw new Error('The selected element type changed. Select it again before sending.')
  const nodes = courseNodes(manifest), ref = target.kind === 'overview' ? null : target.ref
  const current = nodes.find(n => n.id === ref)
  const ancestry = []
  let parent = current?.parentId
  while (parent) { const node = nodes.find(n => n.id === parent); if (!node) break; ancestry.unshift({ ref: node.id, label: node.label }); parent = node.parentId }
  const outline = nodes.filter(n => ['module', 'project', 'lesson', 'markdown', 'quiz', 'exercise', 'image', 'video', 'visualization', 'flashcard'].includes(n.kind)).map(n => ({ ref: n.id, parent: n.parentId, kind: n.kind, label: n.label }))
  const authored = authoringManifest(manifest)
  const selected = ref ? findRef(authored, ref) : { ...authored, modules: undefined }
  return { target, label: current?.label ?? 'Course overview', draftVersion, course: { title: manifest.title, slug: manifest.slug }, ancestry,
    outline: outline.slice(0, 300), outlineTruncated: outline.length > 300,
    selected: JSON.stringify(selected).length <= 24000 ? selected : { ref, note: 'Use read_course to inspect the selected element.' } }
}
export function findRef(value: unknown, ref: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ((value as Record<string, unknown>).ref === ref) return value as Record<string, unknown>
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) { for (const item of child) { const found = findRef(item, ref); if (found) return found } }
    else if (child && typeof child === 'object') { const found = findRef(child, ref); if (found) return found }
  }
  return undefined
}
export { portableManifest }
