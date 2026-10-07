import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CourseManifest } from '../../src/core/types'
import type { CourseDocument } from '../../src/core/course-document'
import { identifyManifest, visitNodes } from '../../src/core/course-document'
import { buildCourse } from '../../src/core/manifest'
import { atomicJSON, courseDirectory, readDocument } from '../../src/main/course-store'
import { registerDocument } from '../../src/main/course-registry'
import { tx } from '../../src/main/db'
import { reloadCourses } from '../../src/main/courses'

/** Install authored fixtures directly; preserve IDs during explicit fixture edits. */
export function installCourseFixture(manifest: CourseManifest, courseId: string = randomUUID(), ids: Record<string, string> = {}) {
  const root = courseDirectory(courseId)
  const previous = existsSync(join(root, 'document.json')) ? readDocument(courseId) : null
  const copy = identifyManifest(manifest, randomUUID)
  const prior = new Map<string, string>()
  const priorPaths = new Map<string, string>()
  if (previous?.manifest) visitNodes(previous.manifest, (node, parent, kind) => {
    const key = `${parent ? priorPaths.get(parent) ?? '' : ''}/${kind}:${String(node.slug ?? node.id ?? node.path ?? '')}`
    priorPaths.set(String(node.nodeId), key)
    prior.set(key, String(node.nodeId))
  })
  const used = new Set<string>()
  const paths = new Map<string, string>()
  visitNodes(copy, (node, parent, kind) => {
    const name = String(node.slug ?? node.id ?? node.path ?? '')
    const key = `${parent ? paths.get(parent) ?? '' : ''}/${kind}:${name}`
    const reuse = ids[name] ?? prior.get(key)
    if (reuse && !used.has(reuse)) node.nodeId = reuse
    used.add(String(node.nodeId))
    paths.set(String(node.nodeId), key)
  })
  const document: CourseDocument = { version: 1, courseId, revision: (previous?.revision ?? 0) + 1, manifest: copy, attachments: [] }
  mkdirSync(join(root, 'package'), { recursive: true })
  atomicJSON(join(root, 'document.json'), document)
  tx((d) => registerDocument(d, document))
  reloadCourses()
  return buildCourse(copy, join(root, 'package'), undefined, courseId, document.revision)
}
