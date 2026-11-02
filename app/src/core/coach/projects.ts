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
import { BACKEND_MODEL, isBackendModelId, normalizeBackendReasoning } from './models'

export const MAX_PROJECT_NAME = 60
export const MAX_INSTRUCTIONS = 8000

export { DEFAULT_INSTRUCTIONS } from './prompt-defaults'
import { DEFAULT_INSTRUCTIONS, normalizeCoachPrompts } from './prompt-defaults'

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
  const backendModel = typeof value['backendModel'] === 'string' && isBackendModelId(value['backendModel']) ? value['backendModel'] : BACKEND_MODEL
  const createdAt = typeof value['createdAt'] === 'string' ? value['createdAt'] : epoch
  return {
    id: value['id'] as string,
    name,
    model: typeof value['model'] === 'string' && value['model'] ? value['model'] : '',
    backendModel,
    backendReasoning: normalizeBackendReasoning(backendModel, value['backendReasoning']),
    voice: typeof value['voice'] === 'string' && value['voice'] ? value['voice'] : '',
    instructions: normalizeInstructions(value['instructions']),
    ...(value['prompts'] && typeof value['prompts'] === 'object' ? { prompts: normalizeCoachPrompts(value['prompts']) } : {}),
    allowDelete: value['allowDelete'] === true,
    createdAt,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : createdAt
  }
}

/** A sqlite row uses snake_case and 0/1; the app uses camelCase and booleans. */
export function projectFromRow(row: Record<string, unknown>): CoachProject | null {
  let prompts: unknown
  try { prompts = typeof row['prompts'] === 'string' ? JSON.parse(row['prompts']) : undefined } catch { /* Legacy behavior for a damaged snapshot. */ }
  return normalizeProject({
    id: row['id'],
    name: row['name'],
    model: row['model'],
    backendModel: row['backend_model'],
    backendReasoning: row['backend_reasoning'],
    voice: row['voice'],
    instructions: row['instructions'],
    prompts,
    allowDelete: row['allow_delete'] === 1 || row['allow_delete'] === true,
    createdAt: row['created_at'],
    updatedAt: row['updated_at']
  })
}
