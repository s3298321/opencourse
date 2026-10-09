import type { AppUpdateInfo, AuthoringTarget, ChatSummary, ChatThread } from '../core/types'
import type { AuthoringCourse, CourseDraft, SaveCourseResult, SavePreview } from '../core/course-document'
import type { AttachmentKind, AttachmentUpload } from '../main/course-authoring'
import type { CourseManifest } from '../core/types'
import type { ReviewAnswer, ReviewCount, ReviewRating, ReviewSession, ReviewSummary } from '../core/types'
import type { LogPage, LogQuery } from '../core/logging/query'
import { contextBridge, ipcRenderer } from 'electron'
import { BRAND } from '../core/brand'
import type {
  ActiveTheme,
  ThemeImportResult,
  ThemeSummary,
  AIModelSettings,
  TitleGenerationConfig,
  TitleGenerationSettings,
  AIProfile,
  AIProvider,
  AIScope,
  SubscriptionStatus,
  ProjectTarget,
  ProjectWorkspace,
  ProjectChatSummary,
  ProjectChatThread,
  ChatLessonRef,
  ChatDefaults,
  ChatModelSettings,
  ChatPickerModels,
  ChatQuote,
  ChatSendResult,
  CoachFileNode,
  CoachKeyResult,
  CoachModel,
  CoachMoveResult,
  CoachSessionSummary,
  CoachStartResult,
  CoachToolOutcome,
  CoachTranscript,
  TranscriptTurn,
  CoachProject,
  CoachProjectSummary,
  CourseProgress,
  CourseSummary,
  CourseView,
  EnvProgress,
  EnvResult,
  ExerciseSession,
  ExerciseTarget,
  GradeResult,
  ImportResult,
  NavAction,
  ReasoningEffort,
  RunOutcome,
  CourseUpdatePreview,
  PublishPreview,
  ServerConnection,
  ServerResult,
  Session,
  UserProfile,
  WriteResult
} from '../core/types'
import type { CatalogPage, CatalogSort, CatalogTag, CourseOverview, ManagedCourse, PublishResult, ServerInfo } from '../core/catalog/api'
import type { UpdateState } from '../core/catalog/origin'

export type RunTestsResult =
  | { status: 'ok'; outcome: RunOutcome; progress: CourseProgress }
  | { status: 'conflict'; content: string; mtimeMs: number }
  | { status: 'env'; error: EnvResult }
  | { status: 'unsupported'; command: string; reason: string }

/** Subscribe helper: every push channel hands back its own unsubscribe. */
function subscribe<A extends unknown[]>(channel: string, handler: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: A): void => handler(...args)
  ipcRenderer.on(channel, listener as (...a: unknown[]) => void)
  return () => ipcRenderer.removeListener(channel, listener as (...a: unknown[]) => void)
}

export interface QuizVerdict extends GradeResult {
  explanation?: string
  progress: CourseProgress
}

export type { NavAction }

const api = {
  getReviewSummary: (courseId: string): Promise<ReviewSummary> => ipcRenderer.invoke('review:summary', courseId),
  startReviewSession: (courseId: string, count: ReviewCount): Promise<ReviewSession> => ipcRenderer.invoke('review:start', courseId, count),
  revealReviewAnswer: (sessionId: string, cardId: string): Promise<ReviewAnswer> => ipcRenderer.invoke('review:reveal', sessionId, cardId),
  rateReviewCard: (sessionId: string, cardId: string, rating: ReviewRating): Promise<ReviewSession> => ipcRenderer.invoke('review:rate', sessionId, cardId, rating),
  endReviewSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('review:end', sessionId),
  resetFlashcardProgress: (courseId: string, cardId: string): Promise<void> => ipcRenderer.invoke('review:reset', courseId, cardId),
  onReviewChanged: (handler: (courseId: string) => void): (() => void) => subscribe('review:changed', handler),
  // --- users ---
  getSession: (): Promise<Session> => ipcRenderer.invoke('session:get'),
  listUsers: (): Promise<UserProfile[]> => ipcRenderer.invoke('users:list'),
  createUser: (name: string): Promise<UserProfile> => ipcRenderer.invoke('users:create', name),
  // No id: a rename applies to whoever is selected, resolved in main.
  renameUser: (name: string): Promise<UserProfile> => ipcRenderer.invoke('users:rename', name),
  switchUser: (id: string): Promise<UserProfile> => ipcRenderer.invoke('users:switch', id),
  deleteUser: (id: string): Promise<Session> => ipcRenderer.invoke('users:delete', id),

  listAuthoringChats: (courseId: string): Promise<ChatSummary[]> => ipcRenderer.invoke('authoringChat:list', courseId),
  getAuthoringChat: (id: string): Promise<ChatThread> => ipcRenderer.invoke('authoringChat:get', id),
  createAuthoringChat: (courseId: string): Promise<ChatSummary> => ipcRenderer.invoke('authoringChat:create', courseId),
  deleteAuthoringChat: (id: string): Promise<void> => ipcRenderer.invoke('authoringChat:delete', id),
  cancelAuthoringChat: (id: string): Promise<void> => ipcRenderer.invoke('authoringChat:cancel', id),
  setAuthoringChatModel: (id: string, model: string): Promise<ChatSummary> => ipcRenderer.invoke('authoringChat:model', id, model),
  setAuthoringChatReasoning: (id: string, reasoning: ReasoningEffort | null): Promise<ChatSummary> => ipcRenderer.invoke('authoringChat:reasoning', id, reasoning),
  /** This conversation's own connection; null follows Settings' default again. */
  setAuthoringChatProvider: (id: string, provider: AIProvider | null): Promise<ChatSummary> => ipcRenderer.invoke('authoringChat:provider', id, provider),
  sendAuthoringMessage: (id: string, text: string, target: AuthoringTarget, revision: number, draftVersion: number, quote?: ChatQuote): Promise<ChatSendResult> => ipcRenderer.invoke('authoringChat:send', id, text, target, revision, draftVersion, quote),
  getAuthoringRunState: (courseId: string): Promise<{ chatId: string | null }> => ipcRenderer.invoke('authoring:runState', courseId),
  stopCourseAuthoring: (courseId: string): Promise<void> => ipcRenderer.invoke('authoring:stop', courseId),
  onAuthoringDraftChanged: (handler: (courseId: string, data: AuthoringCourse, nodeRefMap?: Record<string, string>) => void): (() => void) => subscribe('authoring:draftChanged', handler),
  onAuthoringRunState: (handler: (courseId: string, state: { chatId: string | null }) => void): (() => void) => subscribe('authoring:runState', handler),
  onAuthoringChatDelta: (handler: (id: string, chunk: string) => void): (() => void) => subscribe('authoringChat:delta', handler),
  onAuthoringChatDone: (handler: (id: string) => void): (() => void) => subscribe('authoringChat:done', handler),
  onAuthoringChatTitle: (handler: (id: string, title: string) => void): (() => void) => subscribe('authoringChat:title', handler),
  onAuthoringChatError: (handler: (id: string, error: string) => void): (() => void) => subscribe('authoringChat:error', handler),
  onAuthoringChatActivity: (handler: (id: string, activity: string) => void): (() => void) => subscribe('authoringChat:activity', handler),
  createCourse: (): Promise<AuthoringCourse> => ipcRenderer.invoke('authoring:create'),
  resolveAuthoringAsset: (courseId: string, path: string): Promise<string> => ipcRenderer.invoke('authoring:asset', courseId, path),
  getAuthoringCourse: (courseId: string): Promise<AuthoringCourse> => ipcRenderer.invoke('authoring:get', courseId),
  saveCourseDraft: (courseId: string, manifest: CourseManifest, revision: number, draftVersion: number): Promise<CourseDraft | { status: 'conflict' }> => ipcRenderer.invoke('authoring:draft', courseId, manifest, revision, draftVersion),
  previewCourseSave: (courseId: string): Promise<SavePreview> => ipcRenderer.invoke('authoring:previewSave', courseId),
  saveCourse: (courseId: string, revision: number, draftVersion: number, confirmed = false): Promise<SaveCourseResult> => ipcRenderer.invoke('authoring:save', courseId, revision, draftVersion, confirmed),
  /** Drops the editor's unsaved edits; a course never saved is removed. */
  discardCourseDraft: (courseId: string): Promise<{ removed: boolean }> => ipcRenderer.invoke('authoring:discard', courseId),
  /** Whether main holds unsaved edits for this course - for leaving an editor that is not mounted. */
  isCourseDraftDirty: (courseId: string): Promise<boolean> => ipcRenderer.invoke('authoring:dirty', courseId),
  /** Enables Course ▸ Save Course (⌘S) while an editor is open. */
  setEditorActive: (active: boolean): Promise<void> => ipcRenderer.invoke('menu:editorActive', active),
  uploadCourseAttachment: (courseId: string, kind: AttachmentKind, folder = false): Promise<AttachmentUpload | null> => ipcRenderer.invoke('authoring:upload', courseId, kind, folder),
  exportCourse: (courseId: string): Promise<{ saved: string | null }> => ipcRenderer.invoke('authoring:export', courseId),
  // --- the library ---
  listCourses: (): Promise<CourseSummary[]> => ipcRenderer.invoke('courses:list'),
  getCourse: (courseId: string): Promise<CourseView | null> => ipcRenderer.invoke('course:get', courseId),
  importCourse: (): Promise<ImportResult> => ipcRenderer.invoke('courses:import'),
  removeCourse: (courseId: string): Promise<void> => ipcRenderer.invoke('courses:remove', courseId),
  saveSpec: (): Promise<{ saved: string | null; error?: string }> => ipcRenderer.invoke('spec:save'),
  onCoursesChanged: (handler: () => void): (() => void) => subscribe('courses:changed', handler),
  /** Smoke only: the handler behind this exists solely under OPENCOURSE_SMOKE. */
  importCoursePath: (zipPath: string): Promise<ImportResult> =>
    ipcRenderer.invoke('courses:importPath', zipPath),

  // --- themes: how the app looks, never what it does ---
  // Every id is an app-local UUID; main checks it is one of this user's.
  listThemes: (): Promise<ThemeSummary[]> => ipcRenderer.invoke('themes:list'),
  getActiveTheme: (): Promise<ActiveTheme> => ipcRenderer.invoke('themes:active'),
  /** null is no theme: the app's own look. */
  applyTheme: (id: string | null): Promise<ActiveTheme> => ipcRenderer.invoke('themes:apply', id),
  importTheme: (): Promise<ThemeImportResult> => ipcRenderer.invoke('themes:import'),
  removeTheme: (id: string): Promise<void> => ipcRenderer.invoke('themes:remove', id),
  /** One of the applied theme's fonts, as bytes for a FontFace - fonts never load by URL. */
  themeFontData: (id: string, index: number): Promise<Uint8Array> => ipcRenderer.invoke('themes:fontData', id, index),
  saveThemeSpec: (): Promise<{ saved: string | null; error?: string }> => ipcRenderer.invoke('spec:saveTheme'),
  /** The look changed: a theme was applied or removed, or the user changed. */
  onThemeChanged: (handler: () => void): (() => void) => subscribe('theme:changed', handler),
  /** The installed list changed without the look changing. */
  onThemesChanged: (handler: () => void): (() => void) => subscribe('themes:changed', handler),
  /** Smoke and shots only, like importCoursePath. */
  importThemePath: (zipPath: string, onDuplicate?: 'replace' | 'keep' | 'cancel'): Promise<ThemeImportResult> =>
    ipcRenderer.invoke('themes:importPath', zipPath, onDuplicate),

  // --- updates of the app itself: app-wide, off unless turned on ---
  getAppUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('appUpdate:state'),
  /** A press of "Check for updates": unlike an automatic check, it reports a failure. */
  checkForAppUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('appUpdate:check'),
  /** Download, check and stage the release main found, then restart into it. */
  installAppUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('appUpdate:install'),
  setAppUpdateAutomatic: (on: boolean): Promise<AppUpdateInfo> => ipcRenderer.invoke('appUpdate:setAutomatic', on),
  onAppUpdateChanged: (handler: (info: AppUpdateInfo) => void): (() => void) => subscribe('appUpdate:changed', handler),

  // --- the reader's text size on a lesson screen: one of READING_SCALES ---
  getReadingScale: (): Promise<number> => ipcRenderer.invoke('reading:scale'),
  setReadingScale: (scale: number): Promise<number> => ipcRenderer.invoke('reading:setScale', scale),

  getProgress: (courseId: string): Promise<CourseProgress> => ipcRenderer.invoke('progress:get', courseId),
  toggleLesson: (courseId: string, moduleId: string, lessonId: string): Promise<CourseProgress> =>
    ipcRenderer.invoke('progress:toggleLesson', courseId, moduleId, lessonId),
  touchLesson: (courseId: string, moduleId: string, lessonId: string): Promise<CourseProgress> =>
    ipcRenderer.invoke('progress:touchLesson', courseId, moduleId, lessonId),

  submitQuiz: (courseId: string, blockId: string, answers: string[]): Promise<QuizVerdict> =>
    ipcRenderer.invoke('quiz:submit', courseId, blockId, answers),

  setExerciseDone: (courseId: string, blockId: string, done: boolean): Promise<CourseProgress> =>
    ipcRenderer.invoke('exercise:setDone', courseId, blockId, done),
  getSolution: (courseId: string, blockId: string): Promise<string | null> =>
    ipcRenderer.invoke('exercise:solution', courseId, blockId),

  // --- course projects ---
  openCourseProject: (target: ProjectTarget, recreate = false): Promise<ProjectWorkspace> => ipcRenderer.invoke('project:open', target, recreate),
  setProjectDone: (target: ProjectTarget, done: boolean): Promise<CourseProgress> => ipcRenderer.invoke('project:setDone', target, done),
  openProjectEditor: (target: ProjectTarget, editorId: string): Promise<void> => ipcRenderer.invoke('project:editor', target, editorId),
  revealProject: (target: ProjectTarget): Promise<void> => ipcRenderer.invoke('project:reveal', target),
  listProjectChats: (target: ProjectTarget): Promise<ProjectChatSummary[]> => ipcRenderer.invoke('projectChat:list', target),
  getProjectChat: (id: string): Promise<ProjectChatThread> => ipcRenderer.invoke('projectChat:get', id),
  createProjectChat: (target: ProjectTarget): Promise<ProjectChatSummary> => ipcRenderer.invoke('projectChat:create', target),
  deleteProjectChat: (id: string): Promise<void> => ipcRenderer.invoke('projectChat:delete', id),
  cancelProjectChat: (id: string): Promise<void> => ipcRenderer.invoke('projectChat:cancel', id),
  setProjectChatModel: (id: string, model: string): Promise<ProjectChatSummary> => ipcRenderer.invoke('projectChat:model', id, model),
  setProjectChatReasoning: (id: string, reasoning: ReasoningEffort | null): Promise<ProjectChatSummary> => ipcRenderer.invoke('projectChat:reasoning', id, reasoning),
  setProjectChatProvider: (id: string, provider: AIProvider | null): Promise<ProjectChatSummary> => ipcRenderer.invoke('projectChat:provider', id, provider),
  sendProjectMessage: (id: string, text: string, quote?: ChatQuote, review = false): Promise<ChatSendResult> => ipcRenderer.invoke('projectChat:send', id, text, quote, review),
  onProjectChatDelta: (handler: (id: string, chunk: string) => void): (() => void) => subscribe('projectChat:delta', handler),
  onProjectChatDone: (handler: (id: string) => void): (() => void) => subscribe('projectChat:done', handler),
  onProjectChatTitle: (handler: (id: string, title: string) => void): (() => void) => subscribe('projectChat:title', handler),
  onProjectChatError: (handler: (id: string, message: string) => void): (() => void) => subscribe('projectChat:error', handler),
  onProjectChatActivity: (handler: (id: string, activity: string) => void): (() => void) => subscribe('projectChat:activity', handler),

  // --- the workbench ---
  openExercise: (target: ExerciseTarget): Promise<ExerciseSession> => ipcRenderer.invoke('exercise:open', target),
  readExerciseFile: (target: ExerciseTarget): Promise<{ content: string; mtimeMs: number }> =>
    ipcRenderer.invoke('exercise:read', target),
  writeExerciseFile: (target: ExerciseTarget, content: string, expectedMtimeMs: number | null): Promise<WriteResult> =>
    ipcRenderer.invoke('exercise:write', target, content, expectedMtimeMs),
  ensureEnv: (target: ExerciseTarget): Promise<EnvResult> => ipcRenderer.invoke('env:ensure', target),
  runTests: (
    target: ExerciseTarget,
    content: string,
    expectedMtimeMs: number | null,
    cols: number
  ): Promise<RunTestsResult> => ipcRenderer.invoke('run:tests', target, content, expectedMtimeMs, cols),
  cancelRun: (): Promise<void> => ipcRenderer.invoke('run:cancel'),
  onEnvProgress: (handler: (blockId: string, progress: EnvProgress) => void): (() => void) =>
    subscribe('env:progress', handler),
  onRunData: (handler: (blockId: string, chunk: string) => void): (() => void) => subscribe('run:data', handler),

  // --- the interactive terminal ---
  createPty: (
    sessionId: string,
    options: { cwd: string; envDir?: string; language?: string; cols: number; rows: number }
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('pty:create', sessionId, options),
  writePty: (sessionId: string, data: string): Promise<void> => ipcRenderer.invoke('pty:write', sessionId, data),
  resizePty: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
  killPty: (sessionId: string): Promise<void> => ipcRenderer.invoke('pty:kill', sessionId),
  ptyCount: (): Promise<number> => ipcRenderer.invoke('pty:count'),
  onPtyData: (handler: (sessionId: string, chunk: string) => void): (() => void) => subscribe('pty:data', handler),
  onPtyExit: (handler: (sessionId: string, exitCode: number) => void): (() => void) => subscribe('pty:exit', handler),

  // --- the coach ---
  // The key is write-only from here: `hasOpenAIKey` returns a boolean and a
  // four-character hint, and there is deliberately no way to read it back.
  hasOpenAIKey: (): Promise<{ has: boolean; hint: string | null }> => ipcRenderer.invoke('coach:hasKey'),
  setOpenAIKey: (key: string): Promise<CoachKeyResult> => ipcRenderer.invoke('coach:setKey', key),
  clearOpenAIKey: (): Promise<void> => ipcRenderer.invoke('coach:clearKey'),
  listCoachModels: (): Promise<{ models: CoachModel[]; source: 'api' | 'fallback'; error?: string }> =>
    ipcRenderer.invoke('coach:listModels'),
  getDefaultCoachModel: (): Promise<string> => ipcRenderer.invoke('coach:defaultModel'),
  setDefaultCoachModel: (model: string): Promise<string> => ipcRenderer.invoke('coach:setDefaultModel', model),

  listCoachProjects: (): Promise<CoachProjectSummary[]> => ipcRenderer.invoke('coach:listProjects'),
  getCoachProject: (projectId: string): Promise<CoachProject | null> =>
    ipcRenderer.invoke('coach:getProject', projectId),
  createCoachProject: (draft: {
    name: string
    model?: string
    voice?: string
    instructions?: string
    allowDelete?: boolean
  }): Promise<CoachProject> => ipcRenderer.invoke('coach:createProject', draft),
  updateCoachProject: (
    projectId: string,
    patch: { name?: string; model?: string; voice?: string; instructions?: string; allowDelete?: boolean }
  ): Promise<CoachProject> => ipcRenderer.invoke('coach:updateProject', projectId, patch),
  deleteCoachProject: (projectId: string): Promise<void> => ipcRenderer.invoke('coach:deleteProject', projectId),
  revealCoachProject: (projectId: string): Promise<void> => ipcRenderer.invoke('coach:revealProject', projectId),
  onCoachChanged: (handler: () => void): (() => void) => subscribe('coach:changed', handler),

  // The workspace is readable, movable and deletable - never writable. There is
  // deliberately no counterpart to writeExerciseFile here.
  listCoachFiles: (projectId: string): Promise<CoachFileNode[]> => ipcRenderer.invoke('coach:listFiles', projectId),
  readCoachFile: (
    projectId: string,
    relPath: string
  ): Promise<{ content: string; bytes: number; truncated: boolean }> =>
    ipcRenderer.invoke('coach:readFile', projectId, relPath),
  trashCoachFile: (projectId: string, relPath: string): Promise<CoachMoveResult> =>
    ipcRenderer.invoke('coach:trashFile', projectId, relPath),
  purgeCoachFile: (projectId: string, relPath: string): Promise<CoachMoveResult> =>
    ipcRenderer.invoke('coach:purgeFile', projectId, relPath),
  moveCoachFile: (projectId: string, from: string, to: string): Promise<CoachMoveResult> =>
    ipcRenderer.invoke('coach:moveFile', projectId, from, to),
  createCoachFolder: (projectId: string, parent: string, name: string): Promise<CoachMoveResult> =>
    ipcRenderer.invoke('coach:createFolder', projectId, parent, name),
  onCoachFilesChanged: (handler: (projectId: string) => void): (() => void) =>
    subscribe('coach:filesChanged', handler),

  // A live session. The peer connection lives in the renderer; the credentials
  // never do - `startCoachSession` deliberately returns no secret, and the SDP
  // exchange goes back through main.
  startCoachSession: (projectId: string): Promise<CoachStartResult> =>
    ipcRenderer.invoke('coach:startSession', projectId),
  connectCoachSession: (sessionId: string, offerSdp: string): Promise<{ answerSdp: string }> =>
    ipcRenderer.invoke('coach:connect', sessionId, offerSdp),
  runCoachTool: (sessionId: string, name: string, args: string): Promise<CoachToolOutcome> =>
    ipcRenderer.invoke('coach:tool', sessionId, name, args),
  saveCoachTurns: (sessionId: string, turns: TranscriptTurn[]): Promise<void> =>
    ipcRenderer.invoke('coach:saveTurns', sessionId, turns),
  endCoachSession: (
    sessionId: string,
    outcome: { status: 'ended' | 'failed'; error?: string; turns?: TranscriptTurn[] }
  ): Promise<CoachSessionSummary | null> => ipcRenderer.invoke('coach:endSession', sessionId, outcome),
  listCoachSessions: (projectId: string): Promise<CoachSessionSummary[]> =>
    ipcRenderer.invoke('coach:listSessions', projectId),
  getCoachTranscript: (sessionId: string): Promise<CoachTranscript | null> =>
    ipcRenderer.invoke('coach:getTranscript', sessionId),
  deleteCoachSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('coach:deleteSession', sessionId),

  // --- the side chat ---
  // The reply does not come back from `sendChatMessage`: it streams in on
  // onChatDelta and finishes on onChatDone or onChatError. Main owns that
  // connection because `connect-src 'self'` means this side cannot open it.
  listChats: (courseId: string): Promise<ChatSummary[]> => ipcRenderer.invoke('chat:list', courseId),
  getChat: (chatId: string): Promise<ChatThread | null> => ipcRenderer.invoke('chat:get', chatId),
  createChat: (courseId: string, lesson: ChatLessonRef, model?: string): Promise<ChatSummary> =>
    ipcRenderer.invoke('chat:create', courseId, lesson, model),
  setChatModel: (chatId: string, model: string): Promise<ChatSummary> =>
    ipcRenderer.invoke('chat:setModel', chatId, model),
  setChatReasoning: (chatId: string, reasoning: ReasoningEffort | null): Promise<ChatSummary> =>
    ipcRenderer.invoke('chat:setReasoning', chatId, reasoning),
  /** This chat's own connection, from the composer; null follows Settings' default again. */
  setChatProvider: (chatId: string, provider: AIProvider | null): Promise<ChatSummary> =>
    ipcRenderer.invoke('chat:setProvider', chatId, provider),
  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:delete', chatId),
  cancelChat: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:cancel', chatId),
  sendChatMessage: (
    chatId: string,
    text: string,
    quote: ChatQuote | undefined,
    lesson: ChatLessonRef
  ): Promise<ChatSendResult> => ipcRenderer.invoke('chat:send', chatId, text, quote, lesson),
  // What the picker offers - already narrowed to what Settings left on.
  listChatModels: (scope: AIScope = 'chat', provider?: AIProvider): Promise<ChatPickerModels> => ipcRenderer.invoke('ai:models', scope, provider),
  getAIModelSettings: (scope: AIScope, provider?: AIProvider, refresh = false): Promise<AIModelSettings> => ipcRenderer.invoke('ai:settings', scope, provider, refresh),
  setAIProvider: (scope: AIScope, provider: AIProvider): Promise<void> => ipcRenderer.invoke('ai:provider', scope, provider),
  setAIProfile: (scope: AIScope, provider: AIProvider, profile: AIProfile): Promise<void> => ipcRenderer.invoke('ai:profile', scope, provider, profile),
  getTitleGenerationSettings: (provider?: AIProvider, refresh = false): Promise<TitleGenerationSettings> => ipcRenderer.invoke('ai:titleSettings', provider, refresh),
  setTitleGenerationSettings: (config: TitleGenerationConfig | null): Promise<void> => ipcRenderer.invoke('ai:setTitleSettings', config),
  onAIChanged: (handler: () => void): (() => void) => subscribe('ai:changed', handler),
  getSubscriptionStatus: (): Promise<SubscriptionStatus> => ipcRenderer.invoke('subscription:status'),
  connectSubscription: (id?: string): Promise<SubscriptionStatus> => ipcRenderer.invoke('subscription:connect', id),
  cancelSubscriptionLogin: (): Promise<void> => ipcRenderer.invoke('subscription:cancel'),
  selectSubscriptionAccount: (id: string): Promise<SubscriptionStatus> => ipcRenderer.invoke('subscription:select', id),
  disconnectSubscription: (): Promise<{ warning?: string }> => ipcRenderer.invoke('subscription:disconnect'),
  getChatModelSettings: (): Promise<ChatModelSettings> => ipcRenderer.invoke('chat:modelSettings'),
  setChatDefaults: (defaults: ChatDefaults): Promise<ChatDefaults> => ipcRenderer.invoke('chat:setDefaults', defaults),
  setEnabledChatModels: (ids: string[] | null): Promise<string[] | null> =>
    ipcRenderer.invoke('chat:setEnabledModels', ids),
  getChatWebSearch: (): Promise<boolean> => ipcRenderer.invoke('chat:webSearch'),
  setChatWebSearch: (on: boolean): Promise<boolean> => ipcRenderer.invoke('chat:setWebSearch', on),
  // Icons for the pages one stored answer cited, as data: URLs keyed by host.
  // A message is named, never a site: main decides which hosts to look up.
  getChatSourceIcons: (chatId: string, seq: number): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke('chat:sourceIcons', chatId, seq),
  onChatDelta: (handler: (chatId: string, chunk: string) => void): (() => void) => subscribe('chat:delta', handler),
  onChatDone: (handler: (chatId: string, outcome: { stopped: boolean }) => void): (() => void) =>
    subscribe('chat:done', handler),
  onChatTitle: (handler: (chatId: string, title: string) => void): (() => void) => subscribe('chat:title', handler),
  onChatError: (handler: (chatId: string, message: string) => void): (() => void) => subscribe('chat:error', handler),
  // What an answer is doing besides writing - "Searching the web…".
  onChatActivity: (handler: (chatId: string, activity: string) => void): (() => void) =>
    subscribe('chat:activity', handler),

  // The log, read-only: your lines and the general ones, a page at a time.
  // There is no writer - renderer problems reach the log through main.
  listLogs: (query: Partial<LogQuery>): Promise<LogPage> => ipcRenderer.invoke('logs:list', query),
  listLogScopes: (): Promise<string[]> => ipcRenderer.invoke('logs:scopes'),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),

  // OpenCourse servers. The renderer names a connection by its id and never
  // holds its token; a password crosses once, on its way to the server.
  listServers: (): Promise<ServerConnection[]> => ipcRenderer.invoke('servers:list'),
  probeServer: (url: string): Promise<ServerResult<{ url: string; info: ServerInfo }>> => ipcRenderer.invoke('servers:probe', url),
  startServerSignUp: (url: string, email: string): Promise<ServerResult<{ flowId: string; name: string }>> => ipcRenderer.invoke('servers:signUpStart', url, email),
  resendServerCode: (flowId: string): Promise<ServerResult<void>> => ipcRenderer.invoke('servers:signUpResend', flowId),
  verifyServerCode: (flowId: string, code: string): Promise<ServerResult<void>> => ipcRenderer.invoke('servers:signUpVerify', flowId, code),
  checkServerUsername: (flowId: string, name: string): Promise<ServerResult<{ available: boolean; reason?: string }>> => ipcRenderer.invoke('servers:checkUsername', flowId, name),
  completeServerSignUp: (flowId: string, username: string, password: string): Promise<ServerResult<ServerConnection>> => ipcRenderer.invoke('servers:signUpComplete', flowId, username, password),
  signInToServer: (url: string, login: string, password: string): Promise<ServerResult<ServerConnection>> => ipcRenderer.invoke('servers:signIn', url, login, password),
  startServerPasswordReset: (url: string, email: string): Promise<ServerResult<{ flowId: string; name: string }>> => ipcRenderer.invoke('servers:resetStart', url, email),
  finishServerPasswordReset: (flowId: string, code: string, password: string): Promise<ServerResult<ServerConnection>> => ipcRenderer.invoke('servers:resetFinish', flowId, code, password),
  signOutOfServer: (id: string): Promise<ServerResult<ServerConnection[]>> => ipcRenderer.invoke('servers:signOut', id),
  removeServer: (id: string): Promise<ServerResult<ServerConnection[]>> => ipcRenderer.invoke('servers:remove', id),
  setActiveServer: (id: string | null): Promise<ServerConnection[]> => ipcRenderer.invoke('servers:setActive', id),
  onServersChanged: (handler: () => void): (() => void) => subscribe('servers:changed', handler),
  searchCatalog: (serverId: string, query: { q?: string; tags?: string[]; sort?: CatalogSort; page?: number }): Promise<ServerResult<CatalogPage>> => ipcRenderer.invoke('catalog:search', serverId, query),
  listCatalogTags: (serverId: string): Promise<ServerResult<CatalogTag[]>> => ipcRenderer.invoke('catalog:tags', serverId),
  getCatalogCourse: (serverId: string, courseId: string): Promise<ServerResult<CourseOverview>> => ipcRenderer.invoke('catalog:overview', serverId, courseId),
  // A data: URL, or null - the cover crosses as bytes main has checked.
  getCatalogCover: (serverId: string, courseId: string, version: string): Promise<string | null> => ipcRenderer.invoke('catalog:cover', serverId, courseId, version),
  addCatalogCourse: (serverId: string, courseId: string): Promise<ServerResult<{ courseId: string; title: string; version: string }>> => ipcRenderer.invoke('catalog:add', serverId, courseId),
  checkCourseUpdates: (): Promise<Record<string, UpdateState>> => ipcRenderer.invoke('courses:updates'),
  // An update is previewed first - main downloads it and says what it removes -
  // then applied, or cancelled to drop the download.
  previewCourseUpdate: (courseId: string): Promise<ServerResult<CourseUpdatePreview>> => ipcRenderer.invoke('courses:previewUpdate', courseId),
  cancelCourseUpdate: (courseId: string): Promise<void> => ipcRenderer.invoke('courses:cancelUpdate', courseId),
  applyCourseUpdate: (courseId: string): Promise<ServerResult<{ version: string }>> => ipcRenderer.invoke('courses:applyUpdate', courseId),
  previewPublish: (courseId: string, serverId: string): Promise<ServerResult<PublishPreview>> => ipcRenderer.invoke('publish:preview', courseId, serverId),
  publishCourse: (courseId: string, serverId: string, releaseNote: string): Promise<ServerResult<PublishResult>> => ipcRenderer.invoke('publish:run', courseId, serverId, releaseNote),
  getPublishedCourse: (serverId: string, courseId: string): Promise<ServerResult<ManagedCourse>> => ipcRenderer.invoke('publish:get', serverId, courseId),
  setCurrentPublishedVersion: (serverId: string, courseId: string, version: string): Promise<ServerResult<ManagedCourse>> => ipcRenderer.invoke('publish:setCurrent', serverId, courseId, version),
  deletePublishedVersion: (serverId: string, courseId: string, version: string): Promise<ServerResult<ManagedCourse>> => ipcRenderer.invoke('publish:deleteVersion', serverId, courseId, version),
  unpublishCourse: (serverId: string, courseId: string): Promise<ServerResult<ManagedCourse>> => ipcRenderer.invoke('publish:unpublish', serverId, courseId),
  relistCourse: (serverId: string, courseId: string): Promise<ServerResult<ManagedCourse>> => ipcRenderer.invoke('publish:relist', serverId, courseId),

  onNavigate: (handler: (action: NavAction) => void): (() => void) => subscribe('app:navigate', handler)
}

export type OpenCourseApi = typeof api

contextBridge.exposeInMainWorld(BRAND.name, api)
