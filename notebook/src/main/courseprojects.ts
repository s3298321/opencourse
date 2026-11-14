import { readDocument } from './course-store'
import { assertCourseAvailable } from './course-busy'
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { shell } from 'electron'
import { assertSafeSegment } from '../core/scaffold'
import { findProject } from '../core/manifest'
import { projectContextText } from '../core/projects/context'
import { projectStarterPlan } from '../core/projects/scaffold'
import type { ProjectTarget, ProjectWorkspace } from '../core/types'
import { getCourse } from './courses'
import { dataRoot, courseProjectStateDir, courseProjectDir, courseProjectsRoot } from './paths'
import { requireUser } from './users'
import { assertOwnedProjectAncestors, assertProjectPath } from './projectfiles'
import { editorPreference, installedEditors, launchProjectEditor } from './editors'
export function requireCourseProject(target: ProjectTarget) {
  assertCourseAvailable(target?.courseId)
  assertSafeSegment(target?.courseId, 'course ID')
  assertSafeSegment(target?.moduleId, 'project module ID')
  const course = getCourse(target.courseId)
  const module = course && findProject(course, target.moduleId)
  if (!course || !module) throw new Error('That project is not in your course library.')
  const authored = readDocument(target.courseId).manifest!.modules.find((m) => m.nodeId === target.moduleId)
  if (!authored || authored.type !== 'project') throw new Error('Invalid project ownership.')
  const context = projectContextText(course.title, authored)
  return { course, module, context, fingerprint: createHash('sha256').update(context).digest('hex') }
}
function directory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The project location is not a regular directory.')
  } else { directory(dirname(path)); mkdirSync(path) }
}
export function projectScope(target: ProjectTarget) {
  requireCourseProject(target)
  const userId = requireUser()
  return { root: courseProjectDir(userId, target.courseId, target.moduleId), namespace: courseProjectsRoot(userId), anchor: dataRoot() }
}
export function openCourseProject(target: ProjectTarget, recreate = false): ProjectWorkspace {
  const { module, fingerprint } = requireCourseProject(target)
  const userId = requireUser()
  const scope = projectScope(target)
  const state = join(courseProjectStateDir(userId, target.courseId), `${target.moduleId}.json`)
  assertOwnedProjectAncestors(scope.anchor, scope.root)
  assertOwnedProjectAncestors(scope.anchor, dirname(state))
  let initialized = false
  let seeded: string[] = []
  if (existsSync(state)) {
    if (lstatSync(state).isSymbolicLink()) throw new Error('Invalid project initialization metadata.')
    const stored = JSON.parse(readFileSync(state, 'utf8')) as { initialized?: boolean; seeded?: string[] }
    initialized = stored.initialized === true
    seeded = Array.isArray(stored.seeded) ? stored.seeded.filter((s) => typeof s === 'string') : []
  }
  const result = (): ProjectWorkspace => ({ directory: scope.root, missing: initialized && !existsSync(scope.root), fingerprint, editors: installedEditors().map(({ id, label }) => ({ id, label })), preferredEditor: editorPreference() })
  if (initialized && !existsSync(scope.root) && !recreate) return result()
  if (recreate && !existsSync(scope.root)) { initialized = false; seeded = [] }
  directory(scope.root)
  assertProjectPath(scope, '', true)
  directory(dirname(state))
  const save = (done: boolean): void => {
    const tmp = `${state}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ initialized: done, seeded }), { flag: 'wx', mode: 0o600 })
    renameSync(tmp, state)
  }
  if (!initialized) {
    for (const file of projectStarterPlan(module)) {
      if (seeded.includes(file.path)) continue
      const targetPath = join(scope.root, file.path)
      directory(dirname(targetPath))
      const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
      assertProjectPath(scope, parent, true)
      try {
        const fd = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
        try { writeFileSync(fd, file.content) } finally { closeSync(fd) }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        assertProjectPath(scope, file.path)
      }
      seeded.push(file.path)
      save(false)
    }
    save(true)
  }
  return { ...result(), missing: false }
}
export async function openProjectEditor(target: ProjectTarget, editorId: string): Promise<void> {
  const scope = projectScope(target)
  await launchProjectEditor(assertProjectPath(scope, '', true), editorId)
}
export function revealProject(target: ProjectTarget): void {
  const scope = projectScope(target)
  shell.showItemInFolder(assertProjectPath(scope, '', true))
}
