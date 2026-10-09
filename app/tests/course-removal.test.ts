import { randomUUID, createHash } from 'node:crypto'
import { installCourseFixture } from './helpers/course'
// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectCourse } from './helpers/project'
import { makeZip } from './helpers/zip'

const root = mkdtempSync(join(tmpdir(), 'opencourse-course-removal-'))
let dataDir = join(root, 'data')
vi.mock('electron', () => ({ app: { getPath: () => dataDir, on: () => {} } }))
vi.mock('../src/main/editors', () => ({ installedEditors: () => [], editorPreference: () => null }))
const terminals = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: terminals.spawn }))

const { createUser, switchUser } = await import('../src/main/users')
const { userCoursesDir, userProgressDir, userWorkspaceRoot, courseProjectsRoot, courseProjectStateDir } = await import('../src/main/paths')
const { getCourse, reloadCourses } = await import('../src/main/courses')
const { closeDb, db } = await import('../src/main/db')
const { importCourseZip, removeCourse } = await import('../src/main/import')
const { readProgress, writeProgress } = await import('../src/main/progress')
const { emptyProgress, toggleLesson } = await import('../src/core/progress')
const { insertChat, appendMessage, selectChats, selectMessages } = await import('../src/main/chatdb')
const { insertProjectChat, appendProjectMessage, selectProjectChats, selectProjectMessages, recordProjectTool } = await import('../src/main/projectchatdb')
const { openCourseProject } = await import('../src/main/courseprojects')
const { createProject, listProjects } = await import('../src/main/coach')
const { ensureCourseEnv, runSteps } = await import('../src/main/toolchain')
const { configureBundledPython, bundledPythonDir, BUNDLED_PYTHON_VERSION } = await import('../src/main/bundled-python')
const originalRuntime = bundledPythonDir()
afterEach(() => configureBundledPython(originalRuntime))
const { pythonToolchain } = await import('../src/core/toolchains/python')
const { createPty, disposeAllPtys } = await import('../src/main/pty')

const SLUG = randomUUID()
const OTHER = randomUUID()
const stable = (seed: string): string => { const h = createHash('sha256').update(seed).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}` }
const MODULE = stable(`${SLUG}/portfolio-project`)
const OTHER_MODULE = stable(`${OTHER}/portfolio-project`)
const FIRST = stable(`${SLUG}/intro`)
const OTHER_FIRST = stable(`${OTHER}/intro`)
const AT = '2026-10-04T10:00:00.000Z'
let userId = ''
let n = 0
beforeEach(() => {
  disposeAllPtys()
  terminals.spawn.mockReset()
  closeDb()
  dataDir = join(root, `data-${++n}`)
  userId = createUser('Learner').id
  reloadCourses()
})
afterAll(() => { disposeAllPtys(); closeDb(); rmSync(root, { recursive: true, force: true }) })

function file(path: string, content = 'learner work'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
function install(slug: string = SLUG): void {
  installCourseFixture(projectCourse(), slug, Object.fromEntries(['before', 'intro', 'portfolio-project', 'after', 'reflect'].map((id) => [id, stable(`${slug}/${id}`)])))
}
function populate(slug: string = SLUG): void {
  install(slug)
  const moduleId = stable(`${slug}/portfolio-project`)
  const ref = { moduleId: stable(`${slug}/before`), lessonId: stable(`${slug}/intro`) }
  writeProgress(toggleLesson(emptyProgress(slug), ref.moduleId, ref.lessonId))
  file(join(userWorkspaceRoot(userId), slug, 'exercises', 'obsolete-exercise', 'solution.py'))
  file(join(userWorkspaceRoot(userId), slug, '.venv', 'pyvenv.cfg'))
  file(join(courseProjectsRoot(userId), slug, moduleId, 'README.md'))
  file(join(courseProjectsRoot(userId), slug, 'removed-module', 'notes.md'))
  file(join(courseProjectStateDir(userId, slug), `${moduleId}.json`), '{"initialized":true}')
  insertChat({ id: `lesson-${slug}`, courseId: slug, model: 'gpt-5-mini', startedIn: ref, at: AT })
  appendMessage(`lesson-${slug}`, { role: 'user', text: 'question', lesson: ref, at: AT })
  insertProjectChat({ id: `project-${slug}`, courseId: slug, moduleId, model: 'gpt-5-mini', reasoning: null, createdAt: AT, updatedAt: AT, historyLabel: 'Project conversation' })
  const seq = appendProjectMessage(`project-${slug}`, { role: 'user', text: 'review', at: AT })
  recordProjectTool(db(), `project-${slug}`, seq, 'read', 'read_project_file', {}, 'evidence')
}

describe('deleting a course', () => {
  it('removes all course files, progress, both chat histories and tool evidence, including obsolete modules', async () => {
    populate()
    await removeCourse(SLUG)
    expect(getCourse(SLUG)).toBeUndefined()
    for (const path of [
      join(userCoursesDir(userId), SLUG), join(userProgressDir(userId), `${SLUG}.json`),
      join(userWorkspaceRoot(userId), SLUG), join(courseProjectsRoot(userId), SLUG), courseProjectStateDir(userId, SLUG)
    ]) expect(existsSync(path), path).toBe(false)
    expect(readProgress(SLUG)).toEqual(emptyProgress(SLUG))
    expect(selectChats(SLUG)).toEqual([])
    expect(selectMessages(`lesson-${SLUG}`)).toEqual([])
    expect(selectProjectChats(SLUG, MODULE)).toEqual([])
    expect(selectProjectMessages(`project-${SLUG}`)).toEqual([])
    expect(db().prepare('SELECT COUNT(*) AS n FROM course_project_tool_calls').get()).toMatchObject({ n: 0 })
  })

  it('reimports the same slug with fresh progress, chats and project starters', async () => {
    populate()
    await removeCourse(SLUG)
    const archive = makeZip(join(root, `course-${n}.zip`), [{ name: 'course.json', content: JSON.stringify(projectCourse()) }])
    const imported = await importCourseZip(archive)
    expect(imported.status).toBe('ok')
    if (imported.status !== 'ok') throw new Error('Import failed')
    expect(imported.courseId).not.toBe(SLUG)
    expect(readProgress(SLUG)).toEqual(emptyProgress(SLUG))
    expect(selectChats(SLUG)).toEqual([])
    expect(selectProjectChats(SLUG, MODULE)).toEqual([])
    const importedCourse = getCourse(imported.courseId)!
    const workspace = openCourseProject({ courseId: imported.courseId, moduleId: importedCourse.modules[1].slug })
    expect(workspace.missing).toBe(false)
    expect(readFileSync(join(workspace.directory, 'README.md'), 'utf8')).toContain('Design choices')
    expect(existsSync(join(workspace.directory, 'src', 'portfolio.md'))).toBe(true)
  })

  it('preserves other courses, users and independent Coach projects', async () => {
    populate()
    populate(OTHER)
    const coach = createProject({ name: 'Independent coach' })
    const originalUser = userId
    userId = createUser('Other learner').id
    populate()
    const otherUser = userId
    switchUser(originalUser)
    await removeCourse(SLUG)
    expect(selectChats(OTHER)).toHaveLength(1)
    expect(readProgress(OTHER).completedLessons).toEqual([OTHER_FIRST])
    expect(existsSync(join(courseProjectsRoot(originalUser), OTHER, OTHER_MODULE, 'README.md'))).toBe(true)
    expect(listProjects().map((p) => p.id)).toContain(coach.id)
    switchUser(otherUser)
    expect(getCourse(SLUG)).toBeDefined()
    expect(readProgress(SLUG).completedLessons).toEqual([FIRST])
    expect(selectChats(SLUG)).toHaveLength(1)
    expect(selectProjectChats(SLUG, MODULE)).toHaveLength(1)
    expect(existsSync(join(courseProjectsRoot(otherUser), SLUG, MODULE, 'README.md'))).toBe(true)
  })

  it('allows a course without any learner data to be deleted', async () => {
    install()
    await removeCourse(SLUG)
    expect(getCourse(SLUG)).toBeUndefined()
  })

  it('stops environment creation before removing its workspace', async () => {
    install()
    const courseDir = join(userWorkspaceRoot(userId), SLUG)
    const envDir = join(courseDir, '.venv')
    let creating!: () => void
    const started = new Promise<void>((resolve) => { creating = resolve })
    const runtimeDir = join(root, `runtime-${n}`)
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    symlinkSync(process.execPath, join(runtimeDir, 'bin', 'python3'))
    configureBundledPython(runtimeDir)
    const toolchain = {
      ...pythonToolchain,
      discovery: {
        ...pythonToolchain.discovery,
        probeArgs: () => ['--version'], versionArgs: ['-e', `console.log(${JSON.stringify(BUNDLED_PYTHON_VERSION)})`]
      },
      provision: {
        ...pythonToolchain.provision!,
        create: () => ['-e', 'setInterval(() => {}, 1000)'],
        exe: () => join(envDir, 'not-created-yet')
      }
    }
    const setup = ensureCourseEnv({ toolchain, courseDir, envDir, floor: toolchain.parseFloor(undefined), onProgress: (progress) => {
      if (progress.stage === 'creating') creating()
    } })
    await started
    await removeCourse(SLUG)
    expect(await setup).toMatchObject({ ok: false, message: 'Course environment setup was cancelled.' })
    expect(existsSync(courseDir)).toBe(false)
  })

  it('waits for an active exercise process to stop and leaves another course running', async () => {
    install()
    const cwd = join(userWorkspaceRoot(userId), SLUG, 'exercise')
    const other = join(userWorkspaceRoot(userId), OTHER, 'exercise')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(other, { recursive: true })
    let running!: () => void
    const started = new Promise<void>((resolve) => { running = resolve })
    const first = runSteps(101, {
      toolchain: pythonToolchain, cwd,
      steps: [{ label: 'checks', argv: [process.execPath, '-e', 'process.stdout.write("started"); setInterval(() => {}, 1000)'] }],
      onData: () => running()
    })
    const second = runSteps(102, {
      toolchain: pythonToolchain, cwd: other,
      steps: [{ label: 'checks', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 200)'] }], onData: () => {}
    })
    await started
    await removeCourse(SLUG)
    expect(await first).toMatchObject({ cancelled: true })
    expect(await second).toMatchObject({ cancelled: false, exitCode: 0 })
    expect(existsSync(join(userWorkspaceRoot(userId), SLUG))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('closes course terminals without closing another course with the same slug prefix', async () => {
    install()
    const first = { kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    const other = { kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    terminals.spawn.mockReturnValueOnce(first).mockReturnValueOnce(other)
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
    await createPty(sender as never, { sessionId: 'first', cwd: join(userWorkspaceRoot(userId), SLUG, 'exercise'), cols: 80, rows: 24 })
    await createPty(sender as never, { sessionId: 'other', cwd: join(userWorkspaceRoot(userId), `${SLUG}-other`, 'exercise'), cols: 80, rows: 24 })
    await removeCourse(SLUG)
    expect(first.kill).toHaveBeenCalledOnce()
    expect(other.kill).not.toHaveBeenCalled()
  })

  it.each(['..', '../projects-demo', '', '/projects-demo', 'missing', '%2e%2e'])('refuses an invalid or absent course: %s', async (slug) => {
    populate()
    await expect(removeCourse(slug)).rejects.toThrow()
    expect(getCourse(SLUG)).toBeDefined()
    expect(selectChats(SLUG)).toHaveLength(1)
    expect(readProgress(SLUG).completedLessons).toEqual([FIRST])
  })

  it('rejects a symlinked parent before deleting course data, and does not follow a leaf symlink', async () => {
    populate()
    const projects = courseProjectsRoot(userId)
    const outside = join(root, `external-${n}`)
    file(join(outside, SLUG, 'keep.txt'), 'external work')
    rmSync(projects, { recursive: true })
    symlinkSync(outside, projects)
    await expect(removeCourse(SLUG)).rejects.toThrow('symlinks are excluded')
    expect(selectChats(SLUG)).toHaveLength(1)
    expect(getCourse(SLUG)).toBeDefined()
    expect(readFileSync(join(outside, SLUG, 'keep.txt'), 'utf8')).toBe('external work')
    rmSync(projects)
    mkdirSync(projects)
    symlinkSync(join(outside, SLUG), join(projects, SLUG))
    await removeCourse(SLUG)
    expect(existsSync(join(projects, SLUG))).toBe(false)
    expect(readFileSync(join(outside, SLUG, 'keep.txt'), 'utf8')).toBe('external work')
  })
})
