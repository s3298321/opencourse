/**
 * Server identity, and how it maps onto the app's local identity.
 *
 * A local course's elements carry app-local `nodeId`s, private to one library
 * (course-document.ts). A server course is the other kind: the server keeps one
 * `uid` per element for as long as the course exists, the same for every
 * learner who adds it, so an update can tell an edited lesson from a new one.
 *
 * The mapping is the identity: when a library holds a server course, its
 * course ID *is* the server's course uid and every nodeId *is* the element's
 * uid. A publisher's local course becomes a server course by publishing its
 * existing IDs, so nothing in their library is renamed either.
 *
 * Both directions live here, in core, because the server validates a publish
 * with the same rules the app applies to a download.
 */
import type { CourseManifest } from '../types'
import { courseNodes, currentFormat, visitNodes } from '../course-document'

/** Lowercase UUID v4, as course-schema.json's `uid` pattern and randomUUID() produce. */
export const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The course.json of a server archive: portable, current format, every identity as a uid. */
export function publishedManifest(manifest: CourseManifest, courseId: string): CourseManifest {
  const out = currentFormat(structuredClone(manifest))
  out.uid = courseId
  visitNodes(out, (node) => { node.uid = String(node.nodeId); delete node.nodeId })
  return out
}

function describeNode(node: Record<string, unknown>, kind: string): string {
  return `${kind} "${String(node.slug ?? node.id ?? node.path ?? node.title ?? '?')}"`
}

/** Why a manifest cannot be a server course's: missing, malformed or repeated uids. */
export function publishedIdentityErrors(manifest: CourseManifest): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  if (!UID.test(String(manifest.uid ?? ''))) errors.push('/uid: a server course must carry its own uid')
  else seen.add(String(manifest.uid))
  visitNodes(structuredClone(manifest), (node, _parent, kind) => {
    const uid = String(node.uid ?? '')
    if (!UID.test(uid)) errors.push(`${describeNode(node, kind)}: missing or invalid uid`)
    else if (seen.has(uid)) errors.push(`${describeNode(node, kind)}: uid ${uid} is used twice`)
    seen.add(uid)
  })
  return errors.slice(0, 25)
}

export type AdoptedManifest =
  | { ok: true; courseId: string; manifest: CourseManifest }
  | { ok: false; errors: string[] }

/** A server archive's manifest as a library document holds it: nodeId = uid, no uids left. */
export function adoptPublishedManifest(manifest: CourseManifest): AdoptedManifest {
  const errors = publishedIdentityErrors(manifest)
  if (errors.length) return { ok: false, errors }
  const copy = structuredClone(manifest)
  const courseId = String(copy.uid)
  delete copy.uid
  visitNodes(copy, (node) => { node.nodeId = String(node.uid); delete node.uid })
  return { ok: true, courseId, manifest: copy }
}

/** Every element's uid and kind, for the server's register of which uid belongs to which course. */
export function publishedElements(manifest: CourseManifest): { uid: string; kind: string; parent: string | null }[] {
  const adopted = adoptPublishedManifest(manifest)
  if (!adopted.ok) throw new Error(adopted.errors[0])
  return courseNodes(adopted.manifest).map((node) => ({ uid: node.id, kind: node.kind, parent: node.parentId }))
}
