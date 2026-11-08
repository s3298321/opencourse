import type { AuthoringRunState } from '../core/course-document'
import { EventEmitter } from 'node:events'
import { currentUserId, requireUser } from './users'
import { courseBusy } from './course-busy'

interface Lease { editing: boolean; token: symbol; chatId: string; owner: string; cancel: () => void }
const turns = new Map<string, Lease>()
const key = (courseId: string) => `${requireUser()}/${courseId}`
export const authoringEvents = new EventEmitter()
export function authoringRunState(courseId: string): AuthoringRunState {
  const lease = turns.get(key(courseId))
  return { chatId: lease?.chatId ?? null, editing: lease?.editing ?? false }
}
export function assertAuthoringWritable(courseId: string, token?: symbol): void {
  const lease = turns.get(key(courseId))
  if (token && lease?.token !== token) throw new Error('This authoring turn is no longer active.')
  if (lease && lease.token !== token) throw new Error('The course assistant is editing this draft. Stop it or wait before making changes.')
}
export function beginAuthoringTurn(courseId: string, chatId: string, cancel: () => void) {
  assertAuthoringWritable(courseId)
  if (courseBusy(courseId)) throw new Error('This course is being saved or deleted.')
  const id = key(courseId), token = Symbol(), owner = requireUser()
  turns.set(id, { token, chatId, owner, cancel, editing: false })
  authoringEvents.emit('run', courseId, { chatId, editing: false })
  return { token, markEditing() {
    const lease = turns.get(id)
    if (lease?.token !== token || lease.editing) return
    lease.editing = true
    if (currentUserId() === owner) authoringEvents.emit('run', courseId, { chatId, editing: true })
  }, release: () => {
    if (turns.get(id)?.token !== token) return
    turns.delete(id)
    if (currentUserId() === owner) authoringEvents.emit('run', courseId, { chatId: null, editing: false })
  } }
}
export function cancelCourseAuthoring(courseId: string): void { turns.get(key(courseId))?.cancel() }
/**
 * Stops the assistant and voids its lease at once, so a tool call already in
 * flight is refused rather than writing into an edit session that was just
 * discarded. The turn's own release later finds a different token and is a no-op.
 */
export function revokeAuthoringTurn(courseId: string): void {
  const id = key(courseId), lease = turns.get(id)
  if (!lease) return
  turns.delete(id)
  lease.cancel()
  authoringEvents.emit('run', courseId, { chatId: null, editing: false })
}
