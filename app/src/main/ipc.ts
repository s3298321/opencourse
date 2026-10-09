import { authoringEvents, authoringRunState, cancelCourseAuthoring } from './authoring-state'
import { cancelAllAuthoringChats, cancelAuthoringChat, createAuthoringChat, deleteAuthoringChat, getAuthoringChat, listAuthoringChats, sendAuthoringMessage, setAuthoringChatModel, setAuthoringChatReasoning } from './authoring-chat'
import type { AuthoringTarget } from '../core/types'
import { assertCourseAvailable } from './course-busy'
import { findLesson } from '../core/manifest'
import { makeAssetResolver } from './assets'
import { packageDirectory, readDocument } from './course-store'
import { createCourse, discardCourseDraft, dirtyHolders, exportCourseZip, forgetEditSessions, getAuthoringCourse, isEditSessionDirty, openEditSession, previewCourseSave, releaseEditSessions, saveCourse, saveDraft, uploadCourseAttachment, isCourseCommitting } from './course-authoring'
import { setEditorActive } from './menu'
import { catalogCover, catalogOverview, catalogTags, searchCatalog, type CatalogQuery } from './catalog'
import { addFromServer, applyCourseUpdate, cancelCourseUpdate, courseUpdates, forgetStagedUpdates, previewCourseUpdate } from './server-courses'
import { deletePublishedVersion, previewPublish, publishCourse, publishedCourse, relistCourse, setCurrentPublished, unpublishCourse } from './publish'
import { checkUsername, completeRegistration, finishPasswordReset, forgetServerSessions, listConnections, probeServer, removeConnection, resendRegistrationCode, serverResult, setActiveServer, signIn, signOut, startPasswordReset, startRegistration, verifyRegistration } from './servers'
import type { AttachmentKind } from './course-authoring'
import type { CourseManifest } from '../core/types'
import { cancelAllProjectChats, cancelProjectChat, createProjectChat, deleteProjectChat, getProjectChat, listProjectChats, sendProjectMessage, setProjectChatModel, setProjectChatReasoning } from './projectchat'
import { openCourseProject, openProjectEditor, requireCourseProject, revealProject } from './courseprojects'
/** Typed IPC surface. Everything the renderer can ask the main process to do. */
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import type { AIProfile, AIProvider, AIScope, TitleGenerationConfig } from '../core/types'
import { aiEvents, aiPickerModels, getAIModelSettings, getTitleGenerationSettings, setTitleGenerationSettings, notifyAIChanged, notifyAIConnectionChanged, setAIProfile, setAIProvider, smokeCatalogs } from './ai'
import { cancelSubscriptionLogin, connectSubscription, disconnectSubscription, forgetSubscriptionUser, releaseSubscriptionSession, selectSubscriptionAccount, subscriptionEvents, subscriptionStatus } from './subscription'
import { readFileSync } from 'node:fs'
import { isInside } from '../core/safepath'
import { outputMatch } from '../core/toolchains'
import { grade } from '../core/grading'
import { recordExerciseRun, recordQuizAttempt, setExerciseDone, toggleLesson, touchLesson, touchProject, setProjectDone } from '../core/progress'
import type {
  ProjectTarget,
  Block,
  ChatLessonRef,
  ChatQuote,
  CoachFileNode,
  CoachKeyResult,
  CoachSessionSummary,
  CoachStartResult,
  CoachToolOutcome,
  CoachTranscript,
  TranscriptTurn,
  CoachMoveResult,
  CoachProject,
  CoachProjectSummary,
  Course,
  ImportResult,
  CourseProgress,
  CourseView,
  EnvProgress,
  EnvResult,
  ExerciseBlock,
  ExerciseTarget,
  QuizBlock,
  ReasoningEffort,
  RunOutcome,
  Session,
  UserProfile
} from '../core/types'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  workspaceDir,
  type CoachProjectDraft
} from './coach'
import {
  cancelAllChats,
  cancelChat,
  createChat,
  deleteChat,
  getChat,
  getChatModelSettings,
  listChats,
  listPickerModels,
  sendChatMessage,
  setChatModel,
  setChatDefaults,
  setChatReasoning,
  setEnabledChatModels,
  getChatWebSearch,
  setChatWebSearch,
  getSourceIcons
} from './chat'
import { getDefaultCoachModel, getReadingScale, setDefaultCoachModel, setReadingScale } from './preferences'
import { appUpdateInfo, checkForAppUpdate, installAppUpdate, setAppUpdateAutomatic, updateEvents } from './updates'
import type { ChatDefaults, ThemeImportResult } from '../core/types'
import { closeDb } from './db'
import {
  deleteSessionRow,
  selectSessionRow,
  selectSessionSummary,
  selectSessions,
  selectToolCalls,
  selectTurns
} from './coachdb'
import { createFolder, listFiles, moveFile, purgeFile, readTextFile, trashFile } from './coachfiles'
import { clearKey, forgetVolatileKeys, hasKey, readKey, setKey, storedKeyHint } from './coachkey'
import {
  connectSession,
  countToolCall,
  endAllSessions,
  endSession,
  flushTurns,
  startSession,
  toolCaps
} from './coachsession'
import { runCoachTool } from './coachtools'
import { listRealtimeModels, validateKey, type ModelList } from './openai'
import { getCourse, listCourses } from './courses'
import { importCourseZip, removeCourse } from './import'
import { userWorkspaceRoot } from './paths'
import { readProgress, updateProgress } from './progress'
import { endAllReviews, endReviewSession, getReviewSummary, invalidateCourseReviews, rateReviewCard, resetFlashcardProgress, revealReviewAnswer, startReviewSession } from './review'
import type { ReviewCount, ReviewRating } from '../core/types'
import { cancelRun, ensureCourseEnv, runSteps } from './toolchain'
import { createPty, killPty, ptySessionCount, resizePty, writePty } from './pty'
import { saveSpecBundle, saveThemeSpecBundle } from './spec'
import { applyTheme, getActiveTheme, importThemeZip, listThemes, removeTheme, themeFontData, type DuplicateChoice } from './themes'
import { themeChanged, themesListChanged } from './theme-sync'
import { createUser, deleteUser, getSession, listUsers, renameUser, requireUser, switchUser } from './users'
import { log } from './log'
import { deleteUserLogs, selectLogScopes, selectLogs } from './logdb'
import { normalizeLogQuery, type LogPage } from '../core/logging/query'
import {
  openExercise,
  readExerciseFile,
  revealInFinder,
  runContextFor,
  writeExerciseFile
} from './workspace'

function requireSessionProject(sessionId: string): string {
  const row = selectSessionRow(sessionId)
  if (!row) throw new Error('that session does not exist')
  return row.project_id
}

/** A renderer that navigated or reloaded must not be written to. */
function send(sender: WebContents, channel: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

/** The library changed underneath every window, not just the one that asked. */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) send(win.webContents, channel, ...args)
}

/** One line per import attempt - what was refused, and why, is what a bug report needs. */
function logImport(result: ImportResult): ImportResult {
  const importLog = log.child('import')
  if (result.status === 'ok') importLog.info('Course imported', { courseId: result.courseId, title: result.title })
  else if (result.status !== 'cancelled') importLog.warn('A course archive was refused', { status: result.status, message: result.message })
  return result
}

function finishThemeImport(result: ThemeImportResult): ThemeImportResult {
  if (result.status === 'rejected') log.child('themes').warn('A theme archive was refused', { message: result.message })
  if (result.status !== 'ok') return result
  log.child('themes').info('Theme imported', { themeId: result.theme.id, replaced: result.replaced })
  if (result.replaced && result.theme.active) themeChanged()
  else themesListChanged()
  return result
}

export type RunTestsResult =
  | { status: 'ok'; outcome: RunOutcome; progress: CourseProgress }
  | { status: 'conflict'; content: string; mtimeMs: number }
  | { status: 'env'; error: EnvResult }
  | { status: 'unsupported'; command: string; reason: string }

/** The course as the renderer sees it: no answers, no solutions, no fs paths. */
export type RendererCourse = CourseView

function stripBlock(block: Block): Block {
  if (block.type === 'quiz') {
    const quiz: QuizBlock = {
      ...block,
      options: block.options?.map(({ id, nodeId, text }) => ({ id, nodeId, text, correct: false }))
    }
    delete quiz.answers
    delete quiz.explanation
    return quiz
  }
  if (block.type === 'exercise') {
    const exercise: ExerciseBlock = { ...block }
    delete exercise.solution
    delete exercise.tests
    return exercise
  }
  return block
}

function forRenderer(course: Course): CourseView {
  const { root: _root, ...rest } = course
  return {
    ...rest,
    modules: course.modules.map((mod) => mod.type === 'project' ? mod : ({
      ...mod,
      lessons: mod.lessons.map((lesson) => ({ ...lesson, blocks: lesson.blocks.map(stripBlock),
        flashcards: lesson.flashcards?.map(({ answer: _answer, ...card }) => card) }))
    }))
  }
}

function requireLesson(courseId: string, moduleId: string, lessonId: string) {
  assertCourseAvailable(courseId)
  const course = getCourse(courseId)
  const found = course && findLesson(course, moduleId, lessonId)
  if (!found) throw new Error('That lesson is not in this course.')
  return found
}

function findQuizIn(course: Course, blockId: string): QuizBlock | undefined {
  for (const mod of course.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        if (block.type === 'quiz' && block.id === blockId) return block
      }
    }
  }
  return undefined
}

function findExerciseIn(course: Course, blockId: string): ExerciseBlock | undefined {
  for (const mod of course.modules) {
    if (mod.type === 'project') continue
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        if (block.type === 'exercise' && block.id === blockId) return block
      }
    }
  }
  return undefined
}

/**
 * The close button's dot on macOS: a window holding an edit session with
 * unsaved changes. Main knows, because every edit lands in the session.
 */
function syncDocumentEdited(): void {
  if (process.platform !== 'darwin') return
  const dirty = dirtyHolders()
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setDocumentEdited(dirty.has(win.webContents.id))
}

/** An editor window holds its sessions until it is destroyed, crashes or reloads. */
const editorHolders = new WeakSet<WebContents>()
function holdEditor(sender: WebContents): number {
  const id = sender.id
  if (!editorHolders.has(sender)) {
    editorHolders.add(sender)
    const release = (): void => { try { releaseEditSessions(id) } catch { /* the window is gone either way */ } syncDocumentEdited() }
    sender.once('destroyed', release)
    sender.on('render-process-gone', release)
    sender.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) release() })
  }
  return id
}

export function registerIpc(): void {
  aiEvents.on('changed', () => broadcast('ai:changed'))
  updateEvents.on('changed', () => broadcast('appUpdate:changed', appUpdateInfo()))
  authoringEvents.on('draft', (...args) => { broadcast('authoring:draftChanged', ...args); syncDocumentEdited() })
  authoringEvents.on('run', (...args) => broadcast('authoring:runState', ...args))
  subscriptionEvents.on('changed', notifyAIConnectionChanged)
  subscriptionEvents.on('stop', () => { cancelAllChats('chatgpt'); cancelAllProjectChats('chatgpt'); cancelAllAuthoringChats('chatgpt') })
  app.on('before-quit', releaseSubscriptionSession)
  ipcMain.handle('ai:settings', (_e, scope: AIScope, provider?: AIProvider, refresh = false) => {
    if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) smokeCatalogs()
    return getAIModelSettings(scope, provider, refresh)
  })
  ipcMain.handle('ai:provider', (_e, scope: AIScope, provider: AIProvider) => setAIProvider(scope, provider))
  ipcMain.handle('ai:profile', (_e, scope: AIScope, provider: AIProvider, profile: AIProfile) => setAIProfile(scope, provider, profile))
  ipcMain.handle('ai:titleSettings', (_e, provider?: AIProvider, refresh = false) => {
    if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) smokeCatalogs()
    return getTitleGenerationSettings(provider, refresh)
  })
  ipcMain.handle('ai:setTitleSettings', (_e, config: TitleGenerationConfig | null) => setTitleGenerationSettings(config))
  ipcMain.handle('ai:models', (_e, scope: AIScope) => {
    if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) smokeCatalogs()
    return aiPickerModels(scope)
  })
  ipcMain.handle('subscription:status', subscriptionStatus)
  ipcMain.handle('subscription:connect', (_e, id?: string) => connectSubscription(id))
  ipcMain.handle('subscription:cancel', cancelSubscriptionLogin)
  ipcMain.handle('subscription:select', (_e, id: string) => selectSubscriptionAccount(id))
  ipcMain.handle('subscription:disconnect', disconnectSubscription)
  /* --- who is using the app ---------------------------------------------- */

  ipcMain.handle('session:get', (): Session => getSession())
  ipcMain.handle('users:list', (): UserProfile[] => listUsers())
  ipcMain.handle('users:create', (_e, name: string): UserProfile => {
    endAllReviews()
    releaseSubscriptionSession(); cancelAllChats(); cancelAllProjectChats(); cancelAllAuthoringChats(); endAllSessions(); closeDb(); forgetVolatileKeys()
    const user = createUser(name)
    // After the session moved, so the line is already theirs.
    log.child('users').info('User created and selected')
    return user
  })
  // A rename takes no id: main applies it to whoever is selected, because it
  // rewrites a file whose path main builds.
  ipcMain.handle('users:rename', (_e, name: string): UserProfile => renameUser(name))
  ipcMain.handle('users:switch', (_e, id: string): UserProfile => {
    endAllReviews()
    forgetEditSessions()
    forgetServerSessions()
    forgetStagedUpdates()
    // The coach database and the key are both per user. Let go of them before
    // the session moves, or the next call would be served the old ones - and
    // stop the work that is still holding them first, or an answer still
    // streaming lands in a database that no longer belongs to anyone.
    cancelAllChats()
    cancelAllProjectChats()
    cancelAllAuthoringChats()
    releaseSubscriptionSession()
    endAllSessions()
    closeDb()
    forgetVolatileKeys()
    const user = switchUser(id)
    log.child('users').info('User selected')
    // Themes are per user: the window and the stylesheet follow whoever is in.
    themeChanged()
    return user
  })
  ipcMain.handle('users:delete', (_e, id: string): Session => {
    endAllReviews()
    forgetEditSessions()
    forgetServerSessions()
    forgetStagedUpdates()
    releaseSubscriptionSession()
    cancelAllChats()
    cancelAllProjectChats()
    cancelAllAuthoringChats()
    endAllSessions()
    closeDb()
    forgetVolatileKeys()
    deleteUser(id)
    forgetSubscriptionUser(id)
    // Their log lines are theirs too. Flushed first, so nothing of theirs still
    // queued lands after the delete. Done here rather than in users.ts, which
    // the database layer itself imports.
    log.flush()
    try {
      deleteUserLogs(id)
    } catch (error) {
      log.child('users', { userId: null }).error('A deleted user\'s log lines could not be removed', { error })
    }
    log.child('users', { userId: null }).info('A user was deleted')
    themeChanged()
    return getSession()
  })

  /* --- the log ------------------------------------------------------------- */

  // Read-only, and the user is the session's: the renderer sends a filter, never
  // an id, and the owner clause only ever names that user or the general lines.
  // Flushed first, so the line about what just went wrong is on the page.
  ipcMain.handle('logs:list', (_e, query: unknown): LogPage => {
    log.flush()
    return selectLogs(normalizeLogQuery(query), requireUser())
  })
  ipcMain.handle('logs:scopes', (): string[] => {
    log.flush()
    return selectLogScopes(requireUser())
  })

  /* --- the library -------------------------------------------------------- */

  ipcMain.handle('authoring:runState', (_e, courseId: string) => { readDocument(courseId); return authoringRunState(courseId) })
  ipcMain.handle('authoring:stop', (_e, courseId: string) => { readDocument(courseId); cancelCourseAuthoring(courseId) })
  ipcMain.handle('authoringChat:list', (_e, courseId: string) => listAuthoringChats(courseId))
  ipcMain.handle('authoringChat:get', (_e, id: string) => getAuthoringChat(id))
  ipcMain.handle('authoringChat:create', (_e, courseId: string) => createAuthoringChat(courseId))
  ipcMain.handle('authoringChat:delete', (_e, id: string) => deleteAuthoringChat(id))
  ipcMain.handle('authoringChat:cancel', (_e, id: string) => cancelAuthoringChat(id))
  ipcMain.handle('authoringChat:model', (_e, id: string, model: string) => setAuthoringChatModel(id, model))
  ipcMain.handle('authoringChat:reasoning', (_e, id: string, reasoning: ReasoningEffort | null) => setAuthoringChatReasoning(id, reasoning))
  ipcMain.handle('authoringChat:send', (e, id: string, text: string, target: AuthoringTarget, revision: number, draftVersion: number, quote?: ChatQuote) => sendAuthoringMessage(e.sender, id, text, target, revision, draftVersion, quote))
  // A new course is invisible to the library until its first save, so creating
  // one changes nothing anybody else is showing.
  ipcMain.handle('authoring:create', (e) => { const result = createCourse(); return openEditSession(result.document.courseId, holdEditor(e.sender)) })
  ipcMain.handle('authoring:asset', (_e, courseId: string, path: string) => { readDocument(courseId); return makeAssetResolver(packageDirectory(courseId), courseId)(path) })
  ipcMain.handle('authoring:get', (e, courseId: string) => openEditSession(courseId, holdEditor(e.sender)))
  ipcMain.handle('authoring:dirty', (_e, courseId: string) => isEditSessionDirty(courseId))
  ipcMain.handle('menu:editorActive', (_e, active: boolean) => setEditorActive(active === true))
  ipcMain.handle('authoring:draft', (e, courseId: string, manifest: CourseManifest, revision: number, draftVersion: number) => { const result = saveDraft(courseId, manifest, revision, draftVersion); if (!('status' in result)) for (const win of BrowserWindow.getAllWindows()) if (win.webContents.id !== e.sender.id) send(win.webContents, 'authoring:draftChanged', courseId, getAuthoringCourse(courseId)); syncDocumentEdited(); return result })
  ipcMain.handle('authoring:previewSave', (_e, courseId: string) => previewCourseSave(courseId))
  ipcMain.handle('authoring:save', async (_e, courseId: string, revision: number, draftVersion: number, confirmed: boolean) => {
    const result = await saveCourse(courseId, revision, draftVersion, confirmed === true)
    if (result.status === 'ok') { invalidateCourseReviews(courseId); broadcast('courses:changed') }
    syncDocumentEdited()
    return result
  })
  // Leaving the editor. The assistant is stopped rather than waited for: its
  // edits were part of what is being discarded.
  ipcMain.handle('authoring:discard', (_e, courseId: string) => {
    const result = discardCourseDraft(courseId, { force: true })
    if (!result.removed) broadcast('authoring:draftChanged', courseId, getAuthoringCourse(courseId))
    broadcast('courses:changed'); syncDocumentEdited()
    return result
  })
  ipcMain.handle('authoring:upload', (_e, courseId: string, kind: AttachmentKind, folder: boolean) => {
    if (!['image', 'video', 'visualization'].includes(kind)) throw new Error('Invalid attachment kind.')
    return uploadCourseAttachment(courseId, kind, folder === true)
  })
  ipcMain.handle('authoring:export', (_e, courseId: string) => exportCourseZip(courseId))
  // Servers. Every call answers with a ServerResult, so a refusal arrives as the
  // server's own words rather than as Electron's "Error invoking remote method".
  const changedServers = <T>(result: T): T => { broadcast('servers:changed'); return result }
  ipcMain.handle('servers:list', () => listConnections())
  ipcMain.handle('servers:probe', (_e, url: string) => serverResult(() => probeServer(url)))
  ipcMain.handle('servers:signUpStart', (_e, url: string, email: string) => serverResult(() => startRegistration(url, email)))
  ipcMain.handle('servers:signUpResend', (_e, flowId: string) => serverResult(() => resendRegistrationCode(flowId)))
  ipcMain.handle('servers:signUpVerify', (_e, flowId: string, code: string) => serverResult(() => verifyRegistration(flowId, code)))
  ipcMain.handle('servers:checkUsername', (_e, flowId: string, name: string) => serverResult(() => checkUsername(flowId, name)))
  ipcMain.handle('servers:signUpComplete', async (_e, flowId: string, username: string, password: string) => changedServers(await serverResult(() => completeRegistration(flowId, username, password))))
  ipcMain.handle('servers:signIn', async (_e, url: string, login: string, password: string) => changedServers(await serverResult(() => signIn(url, login, password))))
  ipcMain.handle('servers:resetStart', (_e, url: string, email: string) => serverResult(() => startPasswordReset(url, email)))
  ipcMain.handle('servers:resetFinish', async (_e, flowId: string, code: string, password: string) => changedServers(await serverResult(() => finishPasswordReset(flowId, code, password))))
  ipcMain.handle('servers:signOut', async (_e, id: string) => changedServers(await serverResult(() => signOut(id))))
  ipcMain.handle('servers:remove', async (_e, id: string) => changedServers(await serverResult(() => removeConnection(id))))
  ipcMain.handle('servers:setActive', (_e, id: string | null) => changedServers(setActiveServer(id)))
  ipcMain.handle('catalog:search', (_e, serverId: string, query: CatalogQuery) => serverResult(() => searchCatalog(serverId, query)))
  ipcMain.handle('catalog:tags', (_e, serverId: string) => serverResult(() => catalogTags(serverId)))
  ipcMain.handle('catalog:overview', (_e, serverId: string, courseId: string) => serverResult(() => catalogOverview(serverId, courseId)))
  ipcMain.handle('catalog:cover', (_e, serverId: string, courseId: string, version: string) => catalogCover(serverId, courseId, version).catch(() => null))
  ipcMain.handle('catalog:add', async (_e, serverId: string, courseId: string) => {
    const result = await serverResult(() => addFromServer(serverId, courseId))
    if (result.ok) broadcast('courses:changed')
    return result
  })
  ipcMain.handle('courses:updates', () => courseUpdates())
  ipcMain.handle('courses:previewUpdate', (_e, courseId: string) => serverResult(() => previewCourseUpdate(courseId)))
  ipcMain.handle('courses:cancelUpdate', (_e, courseId: string) => cancelCourseUpdate(courseId))
  ipcMain.handle('courses:applyUpdate', async (_e, courseId: string) => {
    const result = await serverResult(() => applyCourseUpdate(courseId))
    if (result.ok) { invalidateCourseReviews(courseId); broadcast('courses:changed') }
    return result
  })
  ipcMain.handle('publish:preview', (_e, courseId: string, serverId: string) => serverResult(() => previewPublish(courseId, serverId)))
  ipcMain.handle('publish:run', async (_e, courseId: string, serverId: string, note: string) => {
    const result = await serverResult(() => publishCourse(courseId, serverId, note))
    if (result.ok) broadcast('courses:changed')
    return result
  })
  ipcMain.handle('publish:get', (_e, serverId: string, courseId: string) => serverResult(() => publishedCourse(serverId, courseId)))
  ipcMain.handle('publish:setCurrent', (_e, serverId: string, courseId: string, version: string) => serverResult(() => setCurrentPublished(serverId, courseId, version)))
  ipcMain.handle('publish:deleteVersion', (_e, serverId: string, courseId: string, version: string) => serverResult(() => deletePublishedVersion(serverId, courseId, version)))
  ipcMain.handle('publish:unpublish', (_e, serverId: string, courseId: string) => serverResult(() => unpublishCourse(serverId, courseId)))
  ipcMain.handle('publish:relist', (_e, serverId: string, courseId: string) => serverResult(() => relistCourse(serverId, courseId)))
  ipcMain.handle('courses:list' , () => listCourses())

  ipcMain.handle('courses:import', async (_e): Promise<ImportResult> => {
    const owner = requireUser()
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Choose a course archive',
      buttonLabel: 'Import',
      filters: [{ name: 'Course archive', extensions: ['zip'] }],
      properties: ['openFile'] as const
    }
    const picked = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' }

    if (requireUser() !== owner) return { status: 'rejected', message: 'The active user changed during import.' }
    const result = logImport(await importCourseZip(picked.filePaths[0]))
    if (result.status === 'ok') broadcast('courses:changed')
    return result
  })

  /**
   * A smoke or screenshot run cannot answer a native file dialog, so it
   * imports by path instead. Registered only for those runs - the packaged app
   * has no way for the renderer to name a file on disk, and it should stay
   * that way.
   */
  if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) {
    ipcMain.handle('courses:importPath', async (_e, zipPath: string) => {
      const result = logImport(await importCourseZip(zipPath))
      if (result.status === 'ok') broadcast('courses:changed')
      return result
    })
  }

  ipcMain.handle('courses:remove', async (_e, courseId: string) => {
    invalidateCourseReviews(courseId)
    await removeCourse(courseId)
    log.child('import').info('Course removed', { courseId })
    broadcast('courses:changed')
  })

  ipcMain.handle('spec:save', () => saveSpecBundle())
  ipcMain.handle('spec:saveTheme', () => saveThemeSpecBundle())

  /* --- updates of the app itself --------------------------------------------
     App-wide, and off unless turned on (main/updates.ts). The renderer can ask
     to check and to install "the update"; which release that is, and where it
     comes from, stays in main. */

  ipcMain.handle('appUpdate:state', () => appUpdateInfo())
  ipcMain.handle('appUpdate:check', () => checkForAppUpdate(true))
  ipcMain.handle('appUpdate:install', () => installAppUpdate())
  ipcMain.handle('appUpdate:setAutomatic', (_e, on: boolean) => setAppUpdateAutomatic(on === true))

  /* --- the reader's text size ----------------------------------------------
     Per user, in preferences.json, and not a theme's to set: see
     core/reading-scale.ts. Snapped to a step on the way in. */

  ipcMain.handle('reading:scale', () => getReadingScale())
  ipcMain.handle('reading:setScale', (_e, scale: number) => setReadingScale(scale))

  /* --- themes --------------------------------------------------------------
     A theme is values for the stylesheet's tokens and nothing else
     (core/theme). Every id here is an app-local UUID that themes.ts checks
     against the current user's installed themes before building a path. */

  ipcMain.handle('themes:list', () => listThemes())
  ipcMain.handle('themes:active', () => getActiveTheme())
  ipcMain.handle('themes:apply', (_e, id: string | null) => {
    const active = applyTheme(id)
    themeChanged()
    return active
  })
  ipcMain.handle('themes:remove', (_e, id: string) => {
    const { wasActive } = removeTheme(id)
    if (wasActive) themeChanged()
    else themesListChanged()
  })
  ipcMain.handle('themes:fontData', (_e, id: string, index: number) => themeFontData(id, index))
  ipcMain.handle('themes:import', async (): Promise<ThemeImportResult> => {
    const owner = requireUser()
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Choose a theme',
      buttonLabel: 'Import',
      filters: [{ name: 'Theme archive', extensions: ['zip'] }],
      properties: ['openFile'] as Array<'openFile'>
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' }
    if (requireUser() !== owner) return { status: 'rejected', message: 'The active user changed during import.' }
    return finishThemeImport(await importThemeZip(picked.filePaths[0], async (existing, incoming) => {
      const message = { type: 'question' as const, buttons: ['Replace', 'Keep Both', 'Cancel'], defaultId: 0, cancelId: 2,
        message: `“${existing.name}” is already installed.`,
        detail: `Replace it with this copy of “${incoming}”? Replacing keeps it applied if it is the theme you are using.` }
      const answer = win ? await dialog.showMessageBox(win, message) : await dialog.showMessageBox(message)
      return (['replace', 'keep', 'cancel'] as DuplicateChoice[])[answer.response] ?? 'cancel'
    }))
  })
  // Smoke and shots cannot answer a file dialog (see courses:importPath).
  if (process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS']) {
    ipcMain.handle('themes:importPath', async (_e, zipPath: string, onDuplicate: DuplicateChoice = 'replace') =>
      finishThemeImport(await importThemeZip(zipPath, async () => onDuplicate)))
  }

  ipcMain.handle('course:get', (_e, courseId: string) => {
    const course = getCourse(courseId)
    return course ? forRenderer(course) : null
  })

  ipcMain.handle('project:open', (_e, target: ProjectTarget, recreate = false) => {
    const result = openCourseProject(target, recreate === true)
    updateProgress(target.courseId, (p) => touchProject(p, target.moduleId))
    return result
  })
  ipcMain.handle('project:setDone', (_e, target: ProjectTarget, done: boolean) => {
    requireCourseProject(target)
    return updateProgress(target.courseId, (p) => setProjectDone(p, target.moduleId, done === true))
  })
  ipcMain.handle('project:editor', (_e, target: ProjectTarget, editorId: string) => openProjectEditor(target, editorId))
  ipcMain.handle('project:reveal', (_e, target: ProjectTarget) => revealProject(target))
  ipcMain.handle('projectChat:list', (_e, target: ProjectTarget) => listProjectChats(target))
  ipcMain.handle('projectChat:get', (_e, id: string) => getProjectChat(id))
  ipcMain.handle('projectChat:create', (_e, target: ProjectTarget) => createProjectChat(target))
  ipcMain.handle('projectChat:delete', (_e, id: string) => deleteProjectChat(id))
  ipcMain.handle('projectChat:cancel', (_e, id: string) => cancelProjectChat(id))
  ipcMain.handle('projectChat:model', (_e, id: string, model: string) => setProjectChatModel(id, model))
  ipcMain.handle('projectChat:reasoning', (_e, id: string, reasoning: ReasoningEffort | null) => setProjectChatReasoning(id, reasoning))
  ipcMain.handle('projectChat:send', (e, id: string, text: string, quote?: ChatQuote, review = false) => sendProjectMessage(e.sender, id, text, quote, review === true))

  ipcMain.handle('progress:get', (_e, courseId: string): CourseProgress => readProgress(courseId))

  ipcMain.handle('review:summary', (_e, courseId: string) => getReviewSummary(courseId))
  ipcMain.handle('review:start', (e, courseId: string, count: ReviewCount) => startReviewSession(courseId, count, e.sender.id))
  ipcMain.handle('review:reveal', (e, id: string, cardId: string) => revealReviewAnswer(id, cardId, e.sender.id))
  ipcMain.handle('review:rate', (e, id: string, cardId: string, rating: ReviewRating) => {
    const result = rateReviewCard(id, cardId, rating, e.sender.id)
    broadcast('review:changed', result.courseId)
    return result
  })
  ipcMain.handle('review:end', (e, id: string) => endReviewSession(id, e.sender.id))
  ipcMain.handle('review:reset', (_e, courseId: string, cardId: string) => {
    resetFlashcardProgress(courseId, cardId)
    broadcast('review:changed', courseId)
  })

  ipcMain.handle('progress:toggleLesson', (_e, courseId: string, moduleId: string, lessonId: string) => {
    const result = updateProgress(courseId, (p) => toggleLesson(p, requireLesson(courseId, moduleId, lessonId).module.slug, lessonId))
    broadcast('review:changed', courseId)
    return result
  })

  ipcMain.handle('progress:touchLesson', (_e, courseId: string, moduleId: string, lessonId: string) =>
    updateProgress(courseId, (p) => touchLesson(p, requireLesson(courseId, moduleId, lessonId).module.slug, lessonId))
  )

  ipcMain.handle('quiz:submit', (_e, courseId: string, blockId: string, answers: string[]) => {
    assertCourseAvailable(courseId)
    const course = getCourse(courseId)
    const quiz = course && findQuizIn(course, blockId)
    if (!quiz) throw new Error(`unknown quiz: ${blockId}`)

    if (!Array.isArray(answers) || (quiz.options && answers.some((id) => !quiz.options!.some((o) => o.id === id)))) throw new Error('Invalid quiz option.')
    const verdict = grade(quiz, answers)
    const progress = updateProgress(courseId, (p) =>
      recordQuizAttempt(p, blockId, {
        submitted: answers,
        isCorrect: verdict.isCorrect,
        at: new Date().toISOString()
      })
    )
    return { ...verdict, explanation: quiz.explanation, progress }
  })

  ipcMain.handle('exercise:setDone', (_e, courseId: string, blockId: string, done: boolean) => {
    assertCourseAvailable(courseId)
    const course = getCourse(courseId)
    if (!course || !findExerciseIn(course, blockId)) throw new Error('That exercise is not in this course.')
    return updateProgress(courseId, (p) => setExerciseDone(p, blockId, done))
  })

  ipcMain.handle('exercise:solution', (_e, courseId: string, blockId: string) => {
    const course = getCourse(courseId)
    const exercise = course && findExerciseIn(course, blockId)
    return exercise?.solution ?? null
  })

  /* --- the workbench: edit, set up, run ---------------------------------- */

  ipcMain.handle('exercise:open', (_e, target: ExerciseTarget) => openExercise(target))

  ipcMain.handle('exercise:read', (_e, target: ExerciseTarget) => readExerciseFile(target))

  ipcMain.handle('exercise:write', (_e, target: ExerciseTarget, content: string, expectedMtimeMs: number | null) =>
    writeExerciseFile(target, content, expectedMtimeMs)
  )

  ipcMain.handle('env:ensure', async (e, target: ExerciseTarget): Promise<EnvResult> => {
    const { plan, toolchain, runtime } = runContextFor(target)
    const started = Date.now()
    const result = await ensureCourseEnv({
      toolchain,
      courseDir: plan.courseDir,
      envDir: plan.envDir,
      floor: toolchain.parseFloor(runtime.version),
      deps: plan.depsPath ? readFileSync(plan.depsPath, 'utf8') : undefined,
      depsPath: plan.depsPath,
      onProgress: (progress: EnvProgress) => send(e.sender, 'env:progress', target.blockId, progress)
    })
    const toolchainLog = log.child('toolchain')
    if (result.ok) toolchainLog.debug('Course environment ready', { courseId: target.courseId, language: toolchain.id, tool: result.tool, toolVersion: result.toolVersion, ms: Date.now() - started })
    else toolchainLog.error('Course environment setup failed', { courseId: target.courseId, language: toolchain.id, code: result.code, message: result.message, ...(result.code === 'no-tool' ? { tried: result.tried } : { detail: result.detail ?? null }), ms: Date.now() - started })
    return result
  })

  ipcMain.handle(
    'run:tests',
    async (e, target: ExerciseTarget, content: string, expectedMtimeMs: number | null, cols = 80): Promise<RunTestsResult> => {
      // Always write first: running the previous version of the file is the
      // classic in-app-runner bug.
      const written = writeExerciseFile(target, content, expectedMtimeMs)
      if (!written.ok) {
        if (written.reason === 'conflict') {
          return { status: 'conflict', content: written.content, mtimeMs: written.mtimeMs }
        }
        return { status: 'unsupported', command: '', reason: 'the file is too large to save' }
      }

      // Re-scaffold: the test file is regenerated, not preserved, so a learner
      // who edited or deleted the checks gets them back.
      const { plan, toolchain, runtime, exercise } = runContextFor(target)

      // The environment comes first: a compiled language cannot even be planned
      // until its compiler is resolved, since the compiler is argv[0].
      const owner = requireUser()
      const revision = getCourse(target.courseId)!.revision
      const env = await ensureCourseEnv({
        toolchain,
        courseDir: plan.courseDir,
        envDir: plan.envDir,
        floor: toolchain.parseFloor(runtime.version),
        deps: plan.depsPath ? readFileSync(plan.depsPath, 'utf8') : undefined,
        depsPath: plan.depsPath,
        onProgress: (progress: EnvProgress) => send(e.sender, 'env:progress', target.blockId, progress)
      })
      if (!env.ok) return { status: 'env', error: env }
      if (requireUser() !== owner || getCourse(target.courseId)?.revision !== revision || isCourseCommitting(target.courseId)) {
        return { status: 'unsupported', command: '', reason: 'That course is no longer available.' }
      }

      const testPlan = toolchain.plan({
        exerciseDir: plan.exerciseDir,
        envDir: plan.envDir,
        tool: env.tool,
        runtime,
        layout: plan.layout,
        hasTests: plan.hasTests,
        testCommand: exercise.test_command,
        expectedOutput: exercise.expected_output,
        stdin: exercise.stdin,
        match: outputMatch(exercise)
      })
      if (testPlan.kind !== 'ok') {
        return { status: 'unsupported', command: testPlan.command, reason: testPlan.reason }
      }

      const outcome = await runSteps(e.sender.id, {
        toolchain,
        steps: testPlan.steps,
        cwd: plan.exerciseDir,
        envDir: plan.envDir,
        cols,
        onData: (chunk: string) => send(e.sender, 'run:data', target.blockId, chunk)
      })

      // Cancelled runs prove nothing, so they are not recorded at all.
      if (requireUser() !== owner) {
        return { status: 'unsupported', command: '', reason: 'The active user changed.' }
      }
      const progress = outcome.cancelled || getCourse(target.courseId)?.revision !== revision || isCourseCommitting(target.courseId)
        ? readProgress(target.courseId)
        : updateProgress(target.courseId, (p) =>
            recordExerciseRun(p, target.blockId, outcome.exitCode === 0)
          )

      return { status: 'ok', outcome, progress }
    }
  )

  ipcMain.handle('run:cancel', (e) => cancelRun(e.sender.id))

  /* --- the coach ---------------------------------------------------------- */

  /*
   * The key. The renderer's entire view of it is a boolean and a four-character
   * hint - `readKey` is main-only and nothing here returns what it returns.
   */
  ipcMain.handle('coach:hasKey', (): { has: boolean; hint: string | null } => ({
    has: hasKey(),
    hint: storedKeyHint()
  }))

  ipcMain.handle('coach:setKey', async (_e, key: string): Promise<CoachKeyResult> => {
    const result = await setKey(key, validateKey)
    notifyAIConnectionChanged()
    return result
  })

  ipcMain.handle('coach:clearKey', (): void => { cancelAllAuthoringChats('apiKey'); clearKey(); notifyAIConnectionChanged() })

  /** One round trip: the call that fills this list is the call that checks the key. */
  ipcMain.handle('coach:listModels', (): Promise<ModelList> => listRealtimeModels(readKey()))
  ipcMain.handle('coach:defaultModel', () => getDefaultCoachModel())
  ipcMain.handle('coach:setDefaultModel', (_e, model: string) => setDefaultCoachModel(model))

  ipcMain.handle('coach:listProjects', (): CoachProjectSummary[] => listProjects())

  ipcMain.handle('coach:getProject', (_e, projectId: string): CoachProject | null => getProject(projectId))

  ipcMain.handle('coach:createProject', (_e, draft: CoachProjectDraft): CoachProject => {
    const project = createProject(draft)
    broadcast('coach:changed')
    return project
  })

  ipcMain.handle('coach:updateProject', (_e, projectId: string, patch: Partial<CoachProjectDraft>): CoachProject => {
    const project = updateProject(projectId, patch)
    broadcast('coach:changed')
    return project
  })

  ipcMain.handle('coach:deleteProject', (_e, projectId: string): void => {
    deleteProject(projectId)
    broadcast('coach:changed')
  })

  /** The workspace is the user's: they should be able to get at it outside the app. */
  ipcMain.handle('coach:revealProject', (_e, projectId: string): void => revealInFinder(workspaceDir(projectId)))

  /*
   * The workspace. Note what is not here: no channel writes a file. The user
   * reads, moves and deletes; only a live session's tool call can create or
   * change one. Read-only in the app is a missing handler, not a disabled
   * button, and it should stay that way.
   */
  ipcMain.handle('coach:listFiles', (_e, projectId: string): CoachFileNode[] => listFiles(projectId))

  ipcMain.handle('coach:readFile', (_e, projectId: string, relPath: string) => readTextFile(projectId, relPath))

  ipcMain.handle('coach:trashFile', (_e, projectId: string, relPath: string): CoachMoveResult => {
    const result = trashFile(projectId, relPath)
    if (result.status === 'ok') broadcast('coach:filesChanged', projectId)
    return result
  })

  ipcMain.handle('coach:purgeFile', (_e, projectId: string, relPath: string): CoachMoveResult => {
    const result = purgeFile(projectId, relPath)
    if (result.status === 'ok') broadcast('coach:filesChanged', projectId)
    return result
  })

  ipcMain.handle('coach:moveFile', (_e, projectId: string, from: string, to: string): CoachMoveResult => {
    const result = moveFile(projectId, from, to)
    if (result.status === 'ok') broadcast('coach:filesChanged', projectId)
    return result
  })

  ipcMain.handle('coach:createFolder', (_e, projectId: string, parent: string, name: string): CoachMoveResult => {
    const result = createFolder(projectId, parent, name)
    if (result.status === 'ok') broadcast('coach:filesChanged', projectId)
    return result
  })

  /*
   * A live session. The renderer drives the peer connection and the microphone;
   * main keeps the key, the ephemeral secret and the record of what is running.
   * Nothing returned from here contains a credential.
   */
  ipcMain.handle('coach:startSession', (e, projectId: string): Promise<CoachStartResult> =>
    startSession(e.sender, projectId)
  )

  ipcMain.handle('coach:connect', (_e, sessionId: string, offerSdp: string) => connectSession(sessionId, offerSdp))

  ipcMain.handle(
    'coach:tool',
    async (_e, sessionId: string, name: string, args: string): Promise<CoachToolOutcome> => {
      const result = await runCoachTool(sessionId, name, args, toolCaps(sessionId))
      countToolCall(sessionId, name)
      if (!result.ok) log.child('coach').warn('A coach tool call failed', { sessionId, tool: name, summary: result.summary })
      // A file the coach just wrote should appear in the tree beside it.
      if (result.ok && name !== 'web_search' && name !== 'read_file' && name !== 'list_files') {
        broadcast('coach:filesChanged', requireSessionProject(sessionId))
      }
      return result
    }
  )

  ipcMain.handle('coach:saveTurns', (_e, sessionId: string, turns: TranscriptTurn[]): void =>
    flushTurns(sessionId, turns)
  )

  ipcMain.handle(
    'coach:endSession',
    (_e, sessionId: string, outcome: { status: 'ended' | 'failed'; error?: string; turns?: TranscriptTurn[] }) => {
      const summary = endSession(sessionId, outcome)
      broadcast('coach:changed')
      return summary
    }
  )

  ipcMain.handle('coach:listSessions', (_e, projectId: string): CoachSessionSummary[] => selectSessions(projectId))

  ipcMain.handle('coach:getTranscript', (_e, sessionId: string): CoachTranscript | null => {
    const session = selectSessionSummary(sessionId)
    if (!session) return null
    return {
      session,
      instructions: selectSessionRow(sessionId)?.instructions ?? '',
      turns: selectTurns(sessionId),
      toolCalls: selectToolCalls(sessionId)
    }
  })

  ipcMain.handle('coach:deleteSession', (_e, sessionId: string): void => {
    deleteSessionRow(sessionId)
    broadcast('coach:changed')
  })

  /* --- the side chat ------------------------------------------------------ */

  /**
   * The answer does not come back on these promises. `chat:send` returns once
   * the question is stored; the reply arrives on `chat:delta` / `chat:done` /
   * `chat:error`, addressed to the renderer that asked rather than broadcast,
   * because it is that window's conversation and no other's.
   */
  ipcMain.handle('chat:listModels', () => listPickerModels())
  ipcMain.handle('chat:modelSettings', () => getChatModelSettings())
  ipcMain.handle('chat:setDefaults', (_e, defaults: ChatDefaults) => setChatDefaults(defaults))
  ipcMain.handle('chat:setEnabledModels', (_e, ids: string[] | null) => setEnabledChatModels(ids))
  ipcMain.handle('chat:webSearch', () => getChatWebSearch())
  ipcMain.handle('chat:setWebSearch', (_e, on: boolean) => { const result = setChatWebSearch(on === true); notifyAIChanged(); return result })
  ipcMain.handle('chat:sourceIcons', (_e, chatId: string, seq: number) => getSourceIcons(chatId, seq))
  ipcMain.handle('chat:list', (_e, courseId: string) => listChats(courseId))
  ipcMain.handle('chat:get', (_e, chatId: string) => getChat(chatId))
  ipcMain.handle('chat:create', (_e, courseId: string, lesson: ChatLessonRef, model?: string) =>
    createChat(courseId, lesson, model)
  )
  ipcMain.handle('chat:setModel', (_e, chatId: string, model: string) => setChatModel(chatId, model))
  ipcMain.handle('chat:setReasoning', (_e, chatId: string, reasoning: ReasoningEffort | null) =>
    setChatReasoning(chatId, reasoning)
  )
  ipcMain.handle('chat:delete', (_e, chatId: string) => deleteChat(chatId))
  ipcMain.handle('chat:cancel', (_e, chatId: string) => cancelChat(chatId))
  ipcMain.handle(
    'chat:send',
    (e, chatId: string, text: string, quote: ChatQuote | undefined, lesson: ChatLessonRef) =>
      sendChatMessage(e.sender, chatId, text, quote, lesson)
  )

  /* --- the interactive terminal ------------------------------------------ */

  /**
   * The only place the renderer hands main a filesystem path. It echoes back an
   * ExerciseSession, but nothing revalidates it on the way in - and with
   * per-user directories an unchecked cwd is another user's work. Both paths
   * have to resolve inside the current user's workspace.
   */
  ipcMain.handle(
    'pty:create',
    (e, sessionId: string, options: { cwd: string; envDir?: string; cols: number; rows: number }) => {
      const root = userWorkspaceRoot(requireUser())
      const outside = !isInside(root, options.cwd) || (options.envDir !== undefined && !isInside(root, options.envDir))
      if (outside) return { ok: false, error: 'that terminal is outside your workspace' }
      return createPty(e.sender, { sessionId, ...options })
    }
  )
  ipcMain.handle('pty:write', (e, sessionId: string, data: string) => writePty(e.sender, sessionId, data))
  ipcMain.handle('pty:resize', (e, sessionId: string, cols: number, rows: number) =>
    resizePty(e.sender, sessionId, cols, rows)
  )
  ipcMain.handle('pty:kill', (e, sessionId: string) => killPty(e.sender, sessionId))
  ipcMain.handle('pty:count', () => ptySessionCount())

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
