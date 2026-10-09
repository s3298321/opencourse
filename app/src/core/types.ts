/** Shared types for the course format (see docs/course-format.md). */
import type { OutputMatch, RuntimeSpec, VersionFloor } from './toolchains/types'
import type { ThemeNote } from './theme/types'
import type { CourseOrigin } from './catalog/origin'

export type { OutputMatch, RuntimeSpec, VersionFloor }

/**
 * `nodeId` is optional on portable input and required in an app-local document.
 * `uid` is the server identity an OpenCourse server's archives carry on every
 * element; a server course's nodeIds are its uids (core/catalog/identity.ts).
 */
export interface LocalNode { nodeId?: string; uid?: string }

/** Required portable authoring name; learner data is attached to nodeId. */
export interface BlockNode extends LocalNode { slug: string }

/** A read-only support file a course drops next to the learner's work. */
export interface ExtraFile extends LocalNode {
  /** Relative to the exercise directory. No '..', no absolute paths. */
  path: string
  content: string
}

export type Difficulty = 'beginner' | 'intermediate' | 'advanced'
export type QuizKind = 'single' | 'multiple' | 'text'

export interface MarkdownBlock extends BlockNode {
  type: 'markdown'
  content: string
}
export interface ImageBlock extends BlockNode {
  type: 'image'
  src: string
  alt?: string
  caption?: string
}
export interface VideoBlock extends BlockNode {
  type: 'video'
  src: string
  poster?: string
  caption?: string
}
export interface VisualizationBlock extends BlockNode {
  type: 'visualization'
  src: string
  title?: string
  height?: number
}
export interface QuizOption extends LocalNode {
  id: string
  text: string
  correct: boolean
}
export interface QuizBlock extends BlockNode {
  type: 'quiz'
  id: string
  kind: QuizKind
  question: string
  options?: QuizOption[]
  answers?: string[]
  explanation?: string
}
export interface ExerciseBlock extends BlockNode {
  type: 'exercise'
  id: string
  title: string
  prompt: string
  /** Overrides the course runtime for this exercise only. */
  runtime?: RuntimeSpec
  starter_code?: string
  solution?: string
  tests?: string
  test_command?: string
  /** Support files regenerated on every open: a header, a fixture, a Makefile. */
  extra_files?: ExtraFile[]
  /**
   * The other way to verify an exercise: no test file, just the stdout the
   * learner's program has to produce. Ignored when `tests` is present.
   */
  expected_output?: string
  /** Fed to the program on stdin under the expected_output shape. */
  stdin?: string
  match?: OutputMatch
  /** Superseded by `runtime.packages`; still honoured. */
  packages?: string[]
  verification_instructions: string
  hints?: string[]
}

export type Block =
  | MarkdownBlock
  | ImageBlock
  | VideoBlock
  | VisualizationBlock
  | QuizBlock
  | ExerciseBlock

export interface Flashcard extends LocalNode {
  id: string
  question: string
  answer: string
  image?: { src: string; alt?: string }
}
export type LearnerFlashcard = Omit<Flashcard, 'answer'>
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'
export type ReviewCount = 10 | 15 | 20
export interface ReviewSummary {
  total: number
  eligible: number
  due: number
  new: number
  practiced: number
  estimatedRecall: number | null
  nextDue: string | null
}
export interface ReviewCard extends LearnerFlashcard {
  lessonId: string
  lessonTitle: string
  early: boolean
}
export interface ReviewSession {
  id: string
  courseId: string
  courseTitle: string
  total: number
  reviewed: number
  ratings: Record<ReviewRating, number>
  card: ReviewCard | null
  summary: ReviewSummary
}
export interface ReviewAnswer {
  answer: string
  intervals: Record<ReviewRating, string>
}

export interface Lesson extends LocalNode {
  slug: string
  title: string
  objectives?: string[]
  estimated_minutes?: number
  blocks: Block[]
  flashcards?: Flashcard[]
}
export type LearnerLesson = Omit<Lesson, 'flashcards'> & { flashcards?: LearnerFlashcard[] }

export interface LessonModule extends LocalNode {
  type?: 'lessons'
  slug: string
  title: string
  lessons: Lesson[]
}

export interface ProjectRequirement extends LocalNode { id: string; description: string }
export interface ProjectDeliverable extends LocalNode {
  id: string
  title: string
  description: string
  paths?: string[]
  acceptance_criteria: string[]
}
export interface ProjectDefinition extends LocalNode {
  definition: string
  objectives?: string[]
  estimated_minutes?: number
  requirements: ProjectRequirement[]
  deliverables: ProjectDeliverable[]
  starter_files?: ExtraFile[]
}
export interface ProjectModule extends LocalNode {
  type: 'project'
  slug: string
  title: string
  project: ProjectDefinition
  lessons?: never
}
export type Module = LessonModule | ProjectModule
export interface ProjectTarget { courseId: string; moduleId: string }
export interface ProjectRef { kind: 'project'; moduleId: string; title: string; index: number }
export type CourseItemRef = (LessonRef & { kind: 'lesson' }) | ProjectRef
export interface InstalledEditor { id: string; label: string }
export interface ProjectWorkspace {
  directory: string
  missing: boolean
  fingerprint: string
  editors: InstalledEditor[]
  preferredEditor: string | null
}
export interface ProjectProgress {
  startedAt?: string
  completedAt?: string
  reviewedFingerprint?: string
  lastReview?: { chatId: string; seq: number; at: string; fingerprint: string }
}

export interface CourseManifest {
  schema_version: string
  slug: string
  title: string
  /** The course's own MAJOR.MINOR.PATCH; required from 1.5 (core/catalog/semver.ts). */
  version?: string
  /** Server identity of the course, on archives an OpenCourse server serves. */
  uid?: string
  description?: string
  author?: string
  difficulty?: Difficulty
  estimated_hours?: number
  /** Free text: "Programming", "Economics". Purely for the library and the UI. */
  subject?: string
  /** The default runtime for every exercise in the course. */
  runtime?: RuntimeSpec
  /** The v1.1 spelling of `runtime.version`. Still honoured on load. */
  python_version?: string
  prerequisites?: string[]
  tags?: string[]
  cover_image?: string
  modules: Module[]
}

/** A lesson with its position in the course resolved. */
export interface LessonRef {
  moduleId: string
  moduleTitle: string
  lessonId: string
  title: string
  index: number
}

/** What the renderer gets: the manifest plus everything derived from it. */
export interface Course extends CourseManifest {
  courseId: string
  revision: number
  /** Where a server course came from; absent for a local course. */
  origin?: CourseOrigin
  /** Where the course lives on disk. Never sent anywhere but the main process. */
  root: string
  /** Ready-to-use URL for the cover art, if the course has any. */
  coverUrl?: string
  /** Flat lesson order, for prev/next and progress totals. */
  flatLessons: LessonRef[]
  flatItems: CourseItemRef[]
  totalMinutes: number
  quizIds: string[]
  exerciseIds: string[]
}

/** A course as the renderer sees it: no filesystem paths, no answers. */
export type CourseView = Omit<Course, 'root' | 'modules'> & {
  modules: (ProjectModule | (Omit<LessonModule, 'lessons'> & {
    lessons: LearnerLesson[]
  }))[]
}

/** Identifies one exercise. The renderer never sends paths, only these ids. */
export interface ExerciseTarget {
  courseId: string
  blockId: string
}

/** Everything the workbench needs to edit and run one exercise. */
export interface ExerciseSession {
  exerciseDir: string
  courseDir: string
  /** Toolchain id, and its display name, so the renderer never maps one itself. */
  language: string
  languageLabel: string
  /** The toolchain's indent, for a file with nothing indented to read it from. */
  indentUnit: string
  /** The file the editor is bound to. Derived, never a literal. */
  learnerFile: string
  /** Absent for a toolchain with nothing to install, such as C. */
  envDir?: string
  depsPath?: string
  /** Display only - what the README and the workbench show as "the command". */
  testCommand: string
  /** The course ships a test file for this exercise. */
  hasTests: boolean
  /** Tests or an expected-output contract: something can be auto-verified. */
  canRun: boolean
  toolVersion?: string
  content: string
  mtimeMs: number
}

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'conflict'; content: string; mtimeMs: number }
  | { ok: false; reason: 'too-large' }

/** Progress of the one-time course environment setup, streamed to the UI. */
export interface EnvProgress {
  stage: 'looking' | 'creating' | 'installing' | 'warming' | 'ready'
  message: string
}

export type EnvResult =
  | { ok: true; envDir?: string; tool: string; toolVersion: string }
  | {
      ok: false
      code: 'no-tool'
      language: string
      floorLabel: string
      tried: string[]
      hint: string[]
      message: string
    }
  | { ok: false; code: 'failed'; message: string; detail?: string }

export interface RunOutcome {
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  /** Which step failed, when a plan had more than one ('compile', 'run'). */
  failedStep?: string
}

export interface CourseSummary {
  recoveryNotice?: string
  courseId: string
  /** The course's own version, MAJOR.MINOR.PATCH. */
  version?: string
  /** Absent for a local course. */
  origin?: { server: string; serverName: string; role: 'publisher' | 'learner'; publisher: string }
  draft?: boolean
  slug: string
  title: string
  description?: string
  author?: string
  difficulty?: Difficulty
  estimated_hours?: number
  subject?: string
  tags?: string[]
  coverUrl?: string
  lessonCount: number
  projectCount: number
  /** 0-100 for the current user, so the library can show where they left off. */
  progressPercent?: number
  /** Present when the manifest failed to load or validate. */
  error?: string
}

export interface QuizAttempt {
  submitted: string[]
  isCorrect: boolean
  at: string
}

export interface ExerciseProgress {
  completedAt?: string
  lastRun?: { at: string; passed: boolean }
}

export interface CourseProgress {
  courseId: string
  lastLesson?: { moduleId: string; lessonId: string }
  lastItem?: { kind: 'lesson'; moduleId: string; lessonId: string } | { kind: 'project'; moduleId: string }
  projects: Record<string, ProjectProgress>
  lastAccessed?: string
  completedLessons: string[]
  quizAttempts: Record<string, QuizAttempt>
  /**
   * An entry can exist without `completedAt`: a failed run records itself so
   * the workbench can show the last verdict. Test completion with
   * `exercises[id]?.completedAt`, never with the entry's presence.
   */
  exercises: Record<string, ExerciseProgress>
}

export interface GradeResult {
  isCorrect: boolean
  score: number
  correct: string[]
}

/* -------------------------------------------------------------------------- */
/* users                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A local user. No password and no account - `id` names their directory, and
 * `name` is free text that never reaches the filesystem.
 */
export interface UserProfile {
  id: string
  name: string
  color: string
  createdAt: string
  lastUsedAt?: string
}

export interface UsersIndex {
  version: number
  users: UserProfile[]
  /** Who to open on launch, when they still exist. */
  lastActiveUserId?: string
}

/** What the renderer knows about who is signed in. */
export interface Session {
  user: UserProfile | null
  users: UserProfile[]
}

/** The outcome of importing a course archive. */
export type ImportResult =
  | { status: 'ok'; courseId: string; title: string }
  | { status: 'cancelled' }
  | { status: 'invalid'; message: string }
  | { status: 'rejected'; message: string }

/* -------------------------------------------------------------------------- */
/* servers                                                                     */
/* -------------------------------------------------------------------------- */

/** A server this user connected to, as the renderer sees it: no token, ever. */
export interface ServerConnection {
  id: string
  url: string
  name: string
  description: string
  /** Who this user is there; null once they sign out. */
  account: { username: string; email: string } | null
  /** The connection whose catalog the Library shows. */
  active: boolean
}

/** What updating a server course to its current version would do, shown before it does it. */
export interface CourseUpdatePreview {
  from: string
  to: string
  /** Elements the new version no longer has; their progress, chats and workspaces go with them. */
  removed: { id: string; kind: string; label: string }[]
  messages: number
  workspaces: number
  newLessons: number
  newProjects: number
  /** A publisher whose saved course differs from what they installed or published. */
  overwritesLocalEdits: boolean
}

/** What publishing a course would do, and why it cannot yet. */
export interface PublishPreview {
  serverName: string
  title: string
  version: string
  /** The highest version ever published; the next must be higher. Null before the first publish. */
  maxVersion: string | null
  currentVersion: string | null
  /** Why it cannot be published as it is; empty when it can. */
  problems: string[]
}

/**
 * A server call's outcome. Refusals are answers, not exceptions, so the code
 * (`invalid_code`, `username_taken`, `version_not_higher`) and the server's own
 * message reach the person who has to act on them intact.
 */
export type ServerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; errors?: string[]; attemptsLeft?: number; maxVersion?: string }

/* -------------------------------------------------------------------------- */
/* coach                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A coaching project: a system prompt, a model, and a workspace directory the
 * model writes into. Unlike a course, nothing here is authored up front - the
 * project accumulates whatever the coach decides to keep between sessions.
 */
export interface CoachProject {
  id: string
  name: string
  model: string
  voice: string
  /** The project's own system prompt: what the coach is for. User-editable. */
  instructions: string
  /**
   * Whether the coach may delete files. Off by default: the requirements say
   * the *user* can delete, not that the model must be able to.
   */
  allowDelete: boolean
  createdAt: string
  updatedAt: string
}

/** A project as the list screen needs it - no instructions, plus session counts. */
export interface CoachProjectSummary {
  id: string
  name: string
  model: string
  sessions: number
  lastSessionAt?: string
  files: number
}

export interface CoachSessionSummary {
  id: string
  projectId: string
  startedAt: string
  endedAt?: string
  status: 'live' | 'ended' | 'failed'
  model: string
  error?: string
  /** Turn count, so the list can say how much was said without loading it. */
  turns: number
  title: string
}

export interface TranscriptTurn {
  seq: number
  role: 'user' | 'assistant' | 'system'
  text: string
  at: string
}

export interface CoachToolRecord {
  seq: number
  callId: string
  name: string
  arguments: string
  result?: string
  ok: boolean
  at: string
}

export interface CoachTranscript {
  session: CoachSessionSummary
  /** The prompt that produced this transcript, snapshotted when it started. */
  instructions: string
  turns: TranscriptTurn[]
  toolCalls: CoachToolRecord[]
}

/** One entry in a project workspace. `binary` is shown but never opened. */
export interface CoachFileNode {
  name: string
  /** Relative to the project directory, always forward-slashed. */
  path: string
  kind: 'dir' | 'text' | 'binary'
  bytes: number
  modifiedAt: string
  children?: CoachFileNode[]
}

export interface CoachModel {
  id: string
  label: string
}

/**
 * Storing a key can fail in a way that is not exceptional: the platform may
 * have no keychain at all. `unavailable` means it is held for this launch only.
 */
export type CoachKeyResult =
  | { status: 'ok' }
  | { status: 'invalid'; message: string }
  | { status: 'unavailable' }

export type CoachMoveResult =
  | { status: 'ok' }
  | { status: 'exists' }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }

/* -------------------------------------------------------------------------- */
/* side chat                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A message's author. `context` is neither - it is a lesson snapshot the app
 * injected on the learner's behalf, kept as an ordinary message so that "has
 * this chat already been told about this lesson?" is a question about the
 * transcript rather than about hidden state.
 */
export type ChatRole = 'user' | 'assistant' | 'context'

/** Where a message was sent from. A chat outlives any one lesson. */
export interface ChatLessonRef {
  moduleId: string
  lessonId: string
}

/**
 * Where a highlighted passage came from: the lesson (its text, or a
 * visualization in it), the course editor's preview, or one of the assistant's own answers. The model is
 * told which, because "from the lesson" about words it wrote itself is a lie
 * it would then try to reconcile with the lesson.
 */
export type QuoteSource = 'lesson' | 'answer' | 'preview'

export interface ChatQuote {
  text: string
  from: QuoteSource
}

/**
 * One web page an answer leaned on, as OpenAI's `url_citation` annotation
 * reported it: the page, and the span of the answer's own text that cites it.
 * Stored as it arrived; numbering and markers are a rendering decision
 * (core/sidechat/citations.ts), so a better renderer never needs a migration.
 */
export interface ChatCitation {
  url: string
  title: string
  /** Offsets into the message text, in whatever unit OpenAI meant - `citeAnswer` checks. */
  start: number
  end: number
}

export interface ChatMessage {
  seq: number
  role: ChatRole
  text: string
  /** The passage the learner highlighted before asking, if they highlighted one. */
  quote?: ChatQuote
  /** The pages an answer cited from a web search. Absent: it did not use the web. */
  citations?: ChatCitation[]
  /** Which lesson this was sent from. Absent on nothing the app writes. */
  lesson?: ChatLessonRef
  /**
   * That lesson's title as the course has it now, on a lesson's context row
   * only. Filled in by main when the chat is read, never stored: the IDs in
   * `lesson` are UUIDs, and a learner reading "Now reading" wants the title.
   */
  lessonTitle?: string
  project?: { moduleId: string; fingerprint: string }
  authoring?: { target: AuthoringTarget; label: string; draftVersion: number }
  status?: 'complete' | 'stopped' | 'failed'
  /** The settings used for this response, independent of later conversation changes. */
  contextFingerprint?: string
  generation?: { model: string; reasoning: ReasoningEffort | null; provider: AIProvider }
  at: string
}

/**
 * How long a reasoning model thinks before it answers - the Responses API's
 * `reasoning.effort`. Which of these a model accepts depends on the model
 * (core/sidechat/models.ts, `reasoningEffortsFor`), and a chat with none set
 * sends none and gets the model's own default.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type AIProvider = 'apiKey' | 'chatgpt'
export type AIScope = 'chat' | 'project' | 'authoring'
export type AuthoringTarget = { kind: 'overview' } | { kind: 'module' | 'lesson' | 'project' | 'block' | 'flashcard'; ref: string }
export interface AIProfile {
  enabledModels: string[] | null
  defaultModel: string | null
  defaultReasoning: ReasoningEffort | null
}
export interface AISettings {
  chat: { provider: AIProvider; profiles: Record<AIProvider, AIProfile> }
  project: { provider: AIProvider; profiles: Record<AIProvider, AIProfile> }
  authoring: { provider: AIProvider; profiles: Record<AIProvider, AIProfile> }
}
export interface AIConnection {
  provider: AIProvider
  ready: boolean
  message?: string
  account?: string
  volatile?: boolean
}
export interface SubscriptionAccount {
  id: string
  label: string
  connected: boolean
}
export interface SubscriptionStatus {
  accounts: SubscriptionAccount[]
  activeId: string | null
  pending: boolean
  volatile: boolean
}
export interface AIModelSettings {
  scope: AIScope
  provider: AIProvider
  selectedProvider: AIProvider
  profile: AIProfile
  models: ChatModel[]
  source: 'api' | 'cache' | 'fallback'
  error?: string
  connection: AIConnection
  webSearch: boolean
}

export interface TitleGenerationConfig {
  provider: AIProvider
  model: string
  reasoning: ReasoningEffort | null
}
export interface TitleGenerationSettings {
  /** Null keeps the conversation's connection and model, with low reasoning when supported. */
  config: TitleGenerationConfig | null
  provider: AIProvider
  models: ChatModel[]
  source: 'api' | 'cache' | 'fallback'
  error?: string
  connection: AIConnection
}

export interface ChatSummary {
  historyLabel?: string
  provider?: AIProvider
  id: string
  courseId: string
  model: string
  /** Null: the model's own reasoning default. */
  reasoning: ReasoningEffort | null
  /** Where the chat was started, so the history list can say where you were. */
  startedIn: ChatLessonRef | null
  /** The first thing the learner asked. Derived, never stored. */
  title: string
  /** How much was said, so the list can show it without loading it. */
  messages: number
  createdAt: string
  updatedAt: string
}

export interface ChatThread {
  chat: ChatSummary
  messages: ChatMessage[]
}

export interface ProjectChatSummary extends Omit<ChatSummary, 'startedIn'> {
  moduleId: string
  historyLabel?: string
}
export interface ProjectChatThread { chat: ProjectChatSummary; messages: ChatMessage[] }

export interface ModelContextMetadata {
  contextWindow?: number
  maxContextWindow?: number
  autoCompactTokenLimit?: number
}

export interface ChatModel extends ModelContextMetadata {
  id: string
  label: string
  reasoningEfforts?: ReasoningEffort[]
}

export interface ChatDefaults {
  model: string
  reasoning: ReasoningEffort | null
}

/** What Settings needs to choose which models the side chat's picker offers. */
export interface ChatModelSettings {
  defaults: ChatDefaults
  /** Every chat model the key can reach, in picker order. */
  models: ChatModel[]
  /** The ones the picker offers. Null until the learner chooses: all of them. */
  enabled: string[] | null
  /** 'fallback' means there was no list to choose from - no key, or no answer. */
  source: 'api' | 'fallback'
  error?: string
  /** Whether the side chat may search the web. Off until the learner turns it on. */
  webSearch: boolean
}

/** What the side chat's pickers are filled from. */
export interface ChatPickerModels {
  provider?: AIProvider
  connection?: AIConnection
  models: ChatModel[]
  source: 'api' | 'cache' | 'fallback'
  error?: string
  /** Settings' web search switch, so the composer can say whether a question may search. */
  webSearch: boolean
  /** What a chat created now would start with, so a new tab can show it before it exists. */
  defaults?: ChatDefaults
}

/**
 * A user's own settings that are not their name or their key: users/<id>/
 * preferences.json, normalized by core/preferences.ts. A JSON file rather than
 * a table, because it is small and a person might reasonably edit it by hand.
 */
export interface Preferences {
  ai?: AISettings
  titleGeneration?: TitleGenerationConfig
  /** Which chat models the side chat's picker offers. Absent: every one the key can reach. */
  chatModels?: string[]
  defaultChatModel?: string
  defaultChatReasoning?: ReasoningEffort
  defaultCoachModel?: string
  projectEditor?: string
  /**
   * Lets the side chat use OpenAI's web search. Opt-in, because every search is
   * billed on the learner's key on top of the answer; absent means off.
   */
  webSearch?: boolean
  /**
   * The applied theme: the app-local UUID of one under users/<id>/themes.
   * Absent means no theme - the app's own look, which is not itself a theme.
   */
  theme?: string
  /**
   * The server connection whose catalog the Library shows: the id of one in
   * users/<id>/servers/servers.json. Absent, or naming one that is gone: none.
   */
  activeServer?: string
  /**
   * The reader's text size on a lesson screen, one of READING_SCALES
   * (core/reading-scale.ts). Absent means 1 - the app's own size.
   */
  readingScale?: number
}

/**
 * Sending can fail in ways that are outcomes rather than errors. Note what `ok`
 * does not carry: the reply arrives on the push channels, not here.
 */
export type ChatSendResult =
  | { status: 'ok'; seq: number }
  | { status: 'connection-required'; provider: AIProvider; message: string }
  | { status: 'no-key' }
  | { status: 'busy' }
  | { status: 'failed'; message: string }

/**
 * What a menu item asks the renderer to do. It lives here rather than in the
 * preload because main/menu.ts sends these and the preload types them, and
 * when the union was declared twice adding a member meant editing both -
 * silently, since nothing tied them together.
 */
export type NavAction =
  | 'prev'
  | 'next'
  | 'library'
  | 'search'
  | 'users'
  | 'courseNew'
  | 'import'
  | 'coach'
  | 'coachNew'
  | 'settings'
  | 'saveCourse'

/**
 * Starting a session can fail in ways that are outcomes rather than errors:
 * no key yet, a refused microphone, OpenAI saying no. Note what `ok` does not
 * carry - the ephemeral secret stays in main.
 */
export type CoachStartResult =
  | {
      status: 'ok'
      sessionId: string
      model: string
      voice: string
      instructions: string
      tools: unknown[]
      startedAt: string
    }
  | { status: 'no-key' }
  | { status: 'mic-denied' }
  | { status: 'failed'; message: string }

/** What running one tool call produced, as the renderer needs it. */
export interface CoachToolOutcome {
  ok: boolean
  /** Goes back to the model verbatim as the function_call_output. */
  output: string
  /** One line for the activity strip, written for a person. */
  summary: string
}

/* --- themes ---------------------------------------------------------------- */

/** An installed theme, as Settings and the View menu show it. */
export interface ThemeSummary {
  /** The app-local UUID - what `applyTheme` takes. */
  id: string
  /** The archive's own `id`; importing another with the same one replaces this. */
  portableId: string
  name: string
  author?: string
  version?: string
  description?: string
  appearance: 'dark' | 'light'
  /** The theme's preview picture, or null to draw `swatch`. */
  preview: string | null
  /** Background, card, accent, text - enough to recognise it by. */
  swatch: string[]
  notes: ThemeNote[]
  active: boolean
  /** Set when the installed files can no longer be read; such a theme can only be removed. */
  error?: string
}

/** One of the active theme's bundled fonts; its bytes come from `themeFontData(themeId, index)`. */
export interface ActiveThemeFace {
  family: string
  weight: string
  style: 'normal' | 'italic'
}

/** What the renderer applies. `id: null` is the app's own look - no theme at all. */
export type ActiveTheme =
  | { id: null }
  | { id: string; name: string; css: string; appearance: 'dark' | 'light'; faces: ActiveThemeFace[]; logo: string | null }

export type ThemeImportResult =
  | { status: 'ok'; theme: ThemeSummary; replaced: boolean }
  | { status: 'cancelled' }
  | { status: 'rejected'; message: string }

/**
 * Where an update of the app itself stands (main/updates.ts). The display half
 * only: the release it is about stays in main, so the renderer can ask to
 * install "the update" but never name what to download.
 */
export type AppUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'available'; version: string; size: number; notesUrl: string; installable: boolean; reason?: string }
  | { state: 'downloading'; version: string; received: number; total: number }
  | { state: 'verifying'; version: string }
  | { state: 'ready'; version: string }
  /** Something open would be lost by quitting now; `reason` says what. Nothing was downloaded. */
  | { state: 'blocked'; version: string; size: number; notesUrl: string; reason: string }
  | { state: 'error'; message: string; version?: string; notesUrl?: string }

export interface AppUpdateInfo {
  status: AppUpdateStatus
  /** Off unless turned on: while it is off the app never contacts GitHub on its own. */
  automatic: boolean
  currentVersion: string
  /** When the last check finished, successfully or not; null before any. */
  checkedAt: number | null
  /** Where to get the new version by hand, when this copy cannot replace itself. */
  downloadUrl: string
}
