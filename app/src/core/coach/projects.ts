/**
 * Coach project shaping. Pure: the database lives in src/main/coachdb.ts and
 * the workspace in src/main/coachfiles.ts.
 *
 * `normalizeProject` is the same defensive contract as normalizeUsers and
 * normalizeProgress - it is fed both database rows and a hand-editable
 * project.json mirror, and either can be wrong without taking the app down.
 */
import type { CoachProject } from '../types'
import { isProjectId } from './ids'

export const MAX_PROJECT_NAME = 60
export const MAX_INSTRUCTIONS = 8000

/**
 * The starting prompt for a new project. Deliberately about *coaching*, not
 * about any one subject: a coach can be for French, for a viva, for chess
 * openings. The memory protocol is the part that makes sessions accumulate,
 * so it is stated as a standing instruction rather than left to the model.
 */
export const DEFAULT_INSTRUCTIONS = `You are a coach. Your learner will tell you what they want to work on.

Teach by talking. Ask questions, listen to the answers, correct gently and keep the
conversation going - you are not reading a lecture, you are running a practice session.

You have a private workspace of files for this project. Use it to remember, across
sessions, what you could not otherwise carry:

- context.md - what this project is for, how sessions have been going, what is working
  and what is not. Read it at the start of a session; keep it current.
- learned.md - what the learner has demonstrably got right.
- review.md - what to come back to next time, and why.

Read what already exists before you start, so you pick up where you left off rather than
starting over. Write as you go, not only at the end. Keep the files short and useful to
your future self - they are notes, not a transcript.`

export function normalizeProjectName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_PROJECT_NAME) : ''
  if (!name) throw new Error('a coach project needs a name')
  return name
}

export function normalizeInstructions(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim().slice(0, MAX_INSTRUCTIONS) : ''
  return text || DEFAULT_INSTRUCTIONS
}

/** Returns null rather than throwing: one unreadable project must not hide the rest. */
export function normalizeProject(raw: unknown): CoachProject | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!isProjectId(value['id'])) return null

  let name: string
  try {
    name = normalizeProjectName(value['name'])
  } catch {
    name = value['id'] as string
  }
  const epoch = new Date(0).toISOString()
  const createdAt = typeof value['createdAt'] === 'string' ? value['createdAt'] : epoch
  return {
    id: value['id'] as string,
    name,
    model: typeof value['model'] === 'string' && value['model'] ? value['model'] : '',
    voice: typeof value['voice'] === 'string' && value['voice'] ? value['voice'] : '',
    instructions: normalizeInstructions(value['instructions']),
    allowDelete: value['allowDelete'] === true,
    createdAt,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : createdAt
  }
}

/** A sqlite row uses snake_case and 0/1; the app uses camelCase and booleans. */
export function projectFromRow(row: Record<string, unknown>): CoachProject | null {
  return normalizeProject({
    id: row['id'],
    name: row['name'],
    model: row['model'],
    voice: row['voice'],
    instructions: row['instructions'],
    allowDelete: row['allow_delete'] === 1 || row['allow_delete'] === true,
    createdAt: row['created_at'],
    updatedAt: row['updated_at']
  })
}
