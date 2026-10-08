/** Preferences persistence: users/<id>/preferences.json, under the current user. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePreferences } from '../core/preferences'
import { DEFAULT_MODEL, isRealtimeModelId } from '../core/coach/models'
import { DEFAULT_READING_SCALE, normalizeReadingScale } from '../core/reading-scale'
import type { Preferences } from '../core/types'
import { userPreferencesFile } from './paths'
import { requireUser } from './users'

export function readPreferences(): Preferences {
  try {
    return normalizePreferences(JSON.parse(readFileSync(userPreferencesFile(requireUser()), 'utf8')))
  } catch {
    return {}
  }
}

/** Atomic, like the progress writer: a crash mid-save must not truncate the file. */
export function writePreferences(preferences: Preferences): Preferences {
  const target = userPreferencesFile(requireUser())
  const kept = normalizePreferences(preferences)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(kept, null, 2))
  renameSync(tmp, target)
  return kept
}

export function getDefaultCoachModel(): string {
  return readPreferences().defaultCoachModel ?? DEFAULT_MODEL
}

export function setDefaultCoachModel(model: string): string {
  if (typeof model !== 'string' || model.length > 100 || !isRealtimeModelId(model)) {
    throw new Error('Choose a speech-to-speech model.')
  }
  writePreferences({ ...readPreferences(), defaultCoachModel: model })
  return getDefaultCoachModel()
}

/** The reader's text size on a lesson screen; 1 when they have not chosen one. */
export function getReadingScale(): number {
  return readPreferences().readingScale ?? DEFAULT_READING_SCALE
}

/** Snapped to a step, like every other way a scale is read. Returns what was kept. */
export function setReadingScale(scale: number): number {
  const { readingScale: _previous, ...rest } = readPreferences()
  const next = normalizeReadingScale(scale)
  writePreferences(next === DEFAULT_READING_SCALE ? rest : { ...rest, readingScale: next })
  return getReadingScale()
}
