import { BACKEND_MODEL } from '../core/coach/models'
import { coachTitleInput } from '../core/coach/title'
import { selectSessionSummary, selectTurns, updateSessionMetadata } from './coachdb'
import { readKey } from './coachkey'
import { generateCoachTitle } from './openai'
import { currentUserId } from './users'
import { log } from './log'

// One request at a time, including when a history page backfills old sessions.
let queue = Promise.resolve()
const pending = new Map<string, Promise<void>>()
const attempted = new Set<string>()

/** Best effort: failures keep the opener, and are retried on a later app launch. */
export function nameCoachSession(sessionId: string, onChanged: () => void): Promise<void> {
  const owner = currentUserId()
  if (!owner) return Promise.resolve()
  const id = `${owner}:${sessionId}`
  const existing = pending.get(id)
  if (existing) return existing
  if (attempted.has(id)) return Promise.resolve()
  const job = queue.then(async () => {
    try {
      if (currentUserId() !== owner) return
      const session = selectSessionSummary(sessionId)
      if (!session || session.status === 'live' || session.metadata?.generatedTitle || !session.turns) return
      const key = readKey()
      if (!key) return
      const transcript = coachTitleInput(selectTurns(sessionId))
      if (!transcript) return
      attempted.add(id)
      const title = await generateCoachTitle(key, session.metadata?.backendModel ?? BACKEND_MODEL, transcript)
      if (currentUserId() !== owner) return
      const latest = selectSessionSummary(sessionId)
      if (!latest || latest.metadata?.generatedTitle) return
      if (!title) {
        log.child('coach.title', { userId: owner }).warn('The coach returned no usable session title', { sessionId })
        return
      }
      updateSessionMetadata(sessionId, { generatedTitle: title })
      onChanged()
    } catch {
      // Do not log provider messages, titles, or transcript text.
      log.child('coach.title', { userId: owner }).warn('Naming a coach session failed', { sessionId })
    }
  }).finally(() => { pending.delete(id) })
  pending.set(id, job)
  queue = job
  return job
}
