import type { DatabaseSync } from 'node:sqlite'
import { courseNodes } from '../core/course-document'
import type { CourseDocument } from '../core/course-document'

/** Update parents before deleting: moving a child out of a removed parent preserves it. */
export function registerDocument(d: DatabaseSync, document: CourseDocument): void {
  d.prepare('INSERT INTO library_courses(id, revision) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(document.courseId, document.revision)
  const nodes = courseNodes(document.manifest)
  const ids = new Set(nodes.map((n) => n.id))
  for (const node of nodes) {
    const owner = d.prepare('SELECT course_id FROM course_elements WHERE id=?').get(node.id) as { course_id: string } | undefined
    if (owner && owner.course_id !== document.courseId) throw new Error('Element identity belongs to another course.')
    d.prepare('INSERT INTO course_elements(id,course_id,parent_id,kind) VALUES(?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET parent_id=NULL,kind=excluded.kind').run(node.id, document.courseId, node.kind)
  }
  for (const node of nodes) d.prepare('UPDATE course_elements SET parent_id=? WHERE id=?').run(node.parentId, node.id)
  const old = d.prepare('SELECT id FROM course_elements WHERE course_id=?').all(document.courseId) as { id: string }[]
  for (const node of old) if (!ids.has(node.id)) d.prepare('DELETE FROM course_elements WHERE id=?').run(node.id)
}

export function registeredCourse(d: DatabaseSync, id: string): string | null {
  return d.prepare('SELECT id FROM library_courses WHERE id=?').get(id) ? id : null
}
export function registeredElement(d: DatabaseSync, courseId: string, id: string): string | null {
  return d.prepare('SELECT id FROM course_elements WHERE course_id=? AND id=?').get(courseId, id) ? id : null
}
