/** Preferences persistence: users/<id>/preferences.json, under the current user. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePreferences } from '../core/preferences'
import { BACKEND_MODEL, DEFAULT_MODEL, isBackendModelId, isLiveModelId, normalizeBackendReasoning } from '../core/coach/models'
import { DEFAULT_READING_SCALE, normalizeReadingScale } from '../core/reading-scale'
import type { Preferences, ReasoningEffort } from '../core/types'
import { userPreferencesFile } from './paths'
import { requireUser } from './users'
import { normalizePomodoroSettings, validPomodoroMinutes, type PomodoroSettings } from '../core/pomodoro'

export function getPomodoroSettings(): PomodoroSettings {
  return normalizePomodoroSettings(readPreferences().pomodoro)
}

export function setPomodoroSettings(settings: PomodoroSettings): PomodoroSettings {
  if (!validPomodoroMinutes(settings?.studyMinutes) || !validPomodoroMinutes(settings?.breakMinutes)) {
    throw new Error('Choose whole minutes between 1 and 180.')
  }
  writePreferences({ ...readPreferences(), pomodoro: settings })
  return getPomodoroSettings()
}

export function readPreferences(): Preferences {
  try {
    const raw = JSON.parse(readFileSync(userPreferencesFile(requireUser()), 'utf8'))
    const normalized = normalizePreferences(raw)
    if (raw.defaultCoachModel !== normalized.defaultCoachModel && typeof raw.defaultCoachModel === 'string' && raw.defaultCoachModel.includes('realtime')) {
      try { writePreferences(normalized) } catch { /* Keep usable preferences; retry migration on the next read. */ }
    }
    return normalized
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

export function getDefaultCoachBackendModel(): string {
  const preferences = readPreferences()
  const model = preferences.defaultCoachBackendModel ?? BACKEND_MODEL
  return preferences.coachBackendModels?.length && !preferences.coachBackendModels.includes(model) ? preferences.coachBackendModels[0] : model
}

export function getCoachBackendModels(): string[] | null { return readPreferences().coachBackendModels ?? null }

export function getDefaultCoachBackendReasoning(): ReasoningEffort | null {
  return normalizeBackendReasoning(getDefaultCoachBackendModel(), readPreferences().defaultCoachBackendReasoning)
}

export function setDefaultCoachBackendReasoning(value: ReasoningEffort | null): ReasoningEffort | null {
  const reasoning = normalizeBackendReasoning(getDefaultCoachBackendModel(), value)
  if (value !== null && reasoning === null) throw new Error('Choose a supported reasoning level for this background model.')
  writePreferences({ ...readPreferences(), defaultCoachBackendReasoning: reasoning })
  return reasoning
}

export function setCoachBackendModels(models: string[] | null): { enabled: string[] | null; defaultModel: string } {
  if (models !== null && (!Array.isArray(models) || models.length > 200 || !models.every(id => typeof id === 'string' && isBackendModelId(id)))) {
    throw new Error('Choose supported background models with function tools.')
  }
  const { coachBackendModels: _previous, ...preferences } = readPreferences()
  const current = getDefaultCoachBackendModel()
  const enabled = models === null ? null : [...new Set(models)]
  writePreferences({ ...preferences, ...(enabled === null ? {} : { coachBackendModels: enabled }),
    defaultCoachBackendModel: enabled?.length && !enabled.includes(current) ? enabled[0] : current })
  return { enabled: getCoachBackendModels(), defaultModel: getDefaultCoachBackendModel() }
}

export function setDefaultCoachBackendModel(model: string): string {
  if (typeof model !== 'string' || !isBackendModelId(model)) {
    throw new Error('Choose a supported background model with function tools.')
  }
  const enabled = getCoachBackendModels()
  if (enabled !== null && !enabled.includes(model)) throw new Error('Show this background model in Coach settings first.')
  writePreferences({ ...readPreferences(), defaultCoachBackendModel: model })
  return getDefaultCoachBackendModel()
}

export function setDefaultCoachModel(model: string): string {
  if (typeof model !== 'string' || model.length > 100 || !isLiveModelId(model)) {
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

/** Legacy project flags do not grant a global permission. */
export function getCoachAllowDelete(): boolean { return readPreferences().coachAllowDelete === true }
export function setCoachAllowDelete(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new Error('Choose whether coaches may delete files.')
  writePreferences({ ...readPreferences(), coachAllowDelete: value })
  return getCoachAllowDelete()
}

/** Independent from the opt-in learner chat setting. */
export function getAuthoringWebSearch(): boolean { return readPreferences().authoringWebSearch !== false }
export function setAuthoringWebSearch(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new Error('Choose whether course authoring may search the web.')
  writePreferences({ ...readPreferences(), authoringWebSearch: value })
  return getAuthoringWebSearch()
}
