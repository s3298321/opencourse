/**
 * Coach projects: the database row, the workspace directory, and the mirror
 * that ties them together.
 *
 * Each project directory holds a `project.json` alongside the coach's own
 * files. It is never read on the happy path - SQLite is canonical - and exists
 * for the same reason `profile.json` sits in every user directory: if the
 * database is ever quarantined, a quarantine should cost transcripts, not
 * projects. `adoptOrphans` is what cashes that in, on every list.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoachProject, CoachProjectSummary } from '../core/types'
import { newProjectId } from '../core/coach/ids'
import { DEFAULT_VOICE, migrateCoachModel, isLiveModelId, isBackendModelId } from '../core/coach/models'
import { getDefaultCoachBackendModel, getDefaultCoachModel } from './preferences'
import { DEFAULT_INSTRUCTIONS, normalizeInstructions, normalizeProject, normalizeProjectName } from '../core/coach/projects'
import {
  deleteProjectRow,
  insertProject,
  selectProject,
  selectProjects,
  sessionCounts,
  updateProjectRow
} from './coachdb'
import { coachProjectDir, coachProjectsRoot } from './paths'
import { requireUser } from './users'
import { isCoachProjectBusy } from './coach-activity'

export interface CoachProjectDraft {
  name: string
  model?: string
  backendModel?: string
  voice?: string
  instructions?: string
  allowDelete?: boolean
}

/** Bounded: a runaway coach must not turn a list into a filesystem crawl. */
const MAX_COUNTED_FILES = 2000

function projectDir(id: string): string {
  return coachProjectDir(requireUser(), id)
}

function mirrorFile(id: string): string {
  return join(projectDir(id), 'project.json')
}

/** Atomic, like every other writer here: a half-written mirror is worse than none. */
function writeMirror(project: CoachProject): void {
  const dir = projectDir(project.id)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'project.json')
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(project, null, 2))
  renameSync(tmp, target)
}

function readMirror(id: string): CoachProject | null {
  try {
    return normalizeProject(JSON.parse(readFileSync(mirrorFile(id), 'utf8')))
  } catch {
    return null
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  const walk = (at: string, depth: number): void => {
    if (depth > 6 || n >= MAX_COUNTED_FILES) return
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (n >= MAX_COUNTED_FILES) return
      if (entry.isDirectory()) walk(join(at, entry.name), depth + 1)
      else if (entry.name !== 'project.json') n += 1
    }
  }
  try {
    walk(dir, 0)
  } catch {
    /* a directory that vanished mid-walk counts as what we got */
  }
  return n
}

/**
 * Re-adopt any project directory the database does not know about. Covers the
 * quarantine case, and incidentally makes copying a project folder in from a
 * backup work.
 */
function adoptOrphans(known: Set<string>): CoachProject[] {
  const root = coachProjectsRoot(requireUser())
  if (!existsSync(root)) return []
  const adopted: CoachProject[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue
    const project = readMirror(entry.name)
    // The mirror names itself; a directory whose name disagrees with it is not
    // something to guess about.
    if (!project || project.id !== entry.name) continue
    try {
      insertProject(project)
      adopted.push(migrateProject(project))
    } catch {
      /* a race with another window: the row is there now, which is all we wanted */
    }
  }
  return adopted
}

/** Repair the mirror even when an earlier launch stopped after updating SQLite. */
function migrateProject(project: CoachProject): CoachProject {
  const model = migrateCoachModel(project.model)
  const next = model === project.model ? project : { ...project, model }
  if (next !== project) updateProjectRow(next)
  const mirror = readMirror(project.id)
  if (mirror?.model !== model || mirror?.backendModel !== next.backendModel) writeMirror(next)
  return next
}

function checkedModel(model: string): string {
  if (!isLiveModelId(model)) throw new Error('Choose a supported GPT-Live conversation model.')
  return model
}

function checkedBackendModel(model: string): string {
  if (!isBackendModelId(model)) throw new Error('Choose a supported background model with function tools.')
  return model
}

export function listProjects(): CoachProjectSummary[] {
  recoverDeletions()
  const projects = selectProjects().map(migrateProject)
  const orphans = adoptOrphans(new Set(projects.map((p) => p.id)))
  const all = orphans.length ? [...projects, ...orphans] : projects
  const counts = sessionCounts()
  return all
    .map((project) => {
      const count = counts.get(project.id)
      return {
        id: project.id,
        busy: isCoachProjectBusy(project.id),
        name: project.name,
        model: project.model,
        sessions: count?.sessions ?? 0,
        ...(count?.lastSessionAt ? { lastSessionAt: count.lastSessionAt } : {}),
        files: countFiles(projectDir(project.id))
      }
    })
    .sort((a, b) => (b.lastSessionAt ?? '').localeCompare(a.lastSessionAt ?? '') || a.name.localeCompare(b.name))
}

export function getProject(id: string): CoachProject | null {
  const project = selectProject(id)
  return project ? migrateProject(project) : null
}

/** Throws where the renderer sent something impossible; that is an exception, not an outcome. */
export function requireProject(id: string): CoachProject {
  const project = getProject(id)
  if (!project) throw new Error(`unknown coach project: ${id}`)
  return project
}

export function createProject(draft: CoachProjectDraft, now = new Date()): CoachProject {
  const at = now.toISOString()
  const project: CoachProject = {
    id: newProjectId(),
    name: normalizeProjectName(draft.name),
    model: checkedModel(typeof draft.model === 'string' && draft.model ? draft.model : getDefaultCoachModel()),
    backendModel: checkedBackendModel(draft.backendModel ?? getDefaultCoachBackendModel()),
    voice: typeof draft.voice === 'string' && draft.voice ? draft.voice : DEFAULT_VOICE,
    instructions: normalizeInstructions(draft.instructions ?? DEFAULT_INSTRUCTIONS),
    allowDelete: draft.allowDelete === true,
    createdAt: at,
    updatedAt: at
  }
  insertProject(project)
  // The row first: a directory with no row is recoverable, a row with no
  // directory would have the coach writing into nothing.
  writeMirror(project)
  return project
}

export function updateProject(id: string, patch: Partial<CoachProjectDraft>, now = new Date()): CoachProject {
  const current = requireProject(id)
  const next: CoachProject = {
    ...current,
    ...(patch.name !== undefined ? { name: normalizeProjectName(patch.name) } : {}),
    ...(patch.model !== undefined && patch.model ? { model: checkedModel(patch.model) } : {}),
    ...(patch.backendModel !== undefined ? { backendModel: checkedBackendModel(patch.backendModel) } : {}),
    ...(patch.voice !== undefined && patch.voice ? { voice: patch.voice } : {}),
    ...(patch.instructions !== undefined ? { instructions: normalizeInstructions(patch.instructions) } : {}),
    ...(patch.allowDelete !== undefined ? { allowDelete: patch.allowDelete === true } : {}),
    updatedAt: now.toISOString()
  }
  updateProjectRow(next)
  writeMirror(next)
  return next
}

/** Takes the workspace with it: a project is its files as much as its transcripts. */
export function deleteProject(id: string): void {
  requireProject(id)
  if (isCoachProjectBusy(id)) throw new Error('Finish this coach’s session before deleting it.')
  const dir = projectDir(id)
  const staged = join(coachProjectsRoot(requireUser()), `.deleted-${id}`)
  if (existsSync(dir)) renameSync(dir, staged)
  try { deleteProjectRow(id) }
  catch (error) { if (existsSync(staged)) renameSync(staged, dir); throw error }
  // A failed cleanup stays outside the adoptable directories and is retried.
  try { rmSync(staged, { recursive: true, force: true }) } catch { /* next list retries */ }
}

/** Where the coach's files live. Exported for the file tools and for Reveal in Finder. */
export function workspaceDir(id: string): string {
  requireProject(id)
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A crash between staging and the SQL delete restores the workspace. */
function recoverDeletions(): void {
  const root = coachProjectsRoot(requireUser())
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.deleted-')) continue
    const id = entry.name.slice('.deleted-'.length)
    if (!/^cp_[a-zA-Z0-9_-]+$/.test(id)) continue
    const staged = join(root, entry.name)
    try {
      if (selectProject(id)) { if (!existsSync(projectDir(id))) renameSync(staged, projectDir(id)) }
      else rmSync(staged, { recursive: true, force: true })
    } catch { /* preserve recoverable files and retry later */ }
  }
}
