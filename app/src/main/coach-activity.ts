import { EventEmitter } from 'node:events'
import { requireUser } from './users'

// Connecting, live sessions and pending tools all prevent project deletion.
// Capture the owner in the release closure: a late tool may finish after a switch.
const busy = new Map<string, number>()
export const coachActivity = new EventEmitter()
export function isCoachProjectBusy(projectId: string): boolean {
  return (busy.get(`${requireUser()}/${projectId}`) ?? 0) > 0
}
export function holdCoachProject(projectId: string): () => void {
  const key = `${requireUser()}/${projectId}`
  busy.set(key, (busy.get(key) ?? 0) + 1)
  coachActivity.emit('changed')
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (busy.get(key) ?? 1) - 1
    if (remaining) busy.set(key, remaining)
    else busy.delete(key)
    coachActivity.emit('changed')
  }
}
