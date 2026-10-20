/** Shared wire contract. Local file names and secrets never belong in these values. */
import type { ChatModel, ReasoningEffort } from '../types'
export type ContentKind = 'course' | 'document'
export interface ContentRef {
  kind: ContentKind
  id: string
  version: string
}
export interface RemoteContentRef extends ContentRef {
  serverId: string
}
export interface Enrollment extends ContentRef {
  generation: string
  active: boolean
  title: string
  updatedAt: string
}
export interface LearningOperation extends ContentRef {
  idempotencyKey: string
  generation: string
  at: number
  epoch: string
  field: string
  value: unknown
}
export interface LearningField {
  value: unknown
  at: number
  operation: string
}
export interface LearningState {
  enrollment: Enrollment
  epoch: string
  fields: Record<string, LearningField>
  /** Set by `GET /me/learning` only: the held version has a cover at `/learn/:kind/:id/:version/cover`. */
  hasCover?: boolean
}
export interface LearningChange {
  cursor: number
  type: 'state' | 'chat'
  key: string
  value: unknown
}
export interface SyncPage {
  changes: LearningChange[]
  cursor: number
  more: boolean
  serverTime: number
}
export interface SyncResult {
  accepted: string[]
  rejected: { id: string; code: string }[]
  serverTime: number
}
export interface PublishedDocument {
  id: string
  title: string
  description: string
  tags: string[]
  version: string
  publisher: string
  hasCover: boolean
  bytes: number
  pages: number
  fingerprint: string
  status: 'indexing' | 'ready' | 'error'
  error: string | null
  sections: { id: string; title: string; page: number; depth: number }[]
  listed: boolean
  ownedByYou: boolean
  /** Accounts that ever added it. */
  downloads: number
  /** When the current version was published. */
  updatedAt: string
  /** The highest version ever published; a new one must be higher. */
  maxVersion: string
  /** Set for the owner only, when a moderator removed it from the catalog. */
  moderated?: boolean
  versions: { version: string; publishedAt: string; releaseNote: string; deleted: boolean }[]
}
/** The model and reasoning level one activity uses. */
export interface ServerAIDefaults {
  model: string
  /** Null sends none: the model's own default, which every model accepts. */
  reasoning: ReasoningEffort | null
}
/**
 * An account's AI on one server. Only the activities a server runs are here:
 * study chat (courses and documents alike) and naming its conversations.
 * Course authoring and Coach run in the app, on the app's own settings.
 */
export interface ServerAISettings extends ServerAIDefaults {
  /** Null offers all models; an empty list disables chat. */
  enabledModels?: string[] | null
  configured: boolean
  hint: string | null
  webSearch: boolean
  /** Null names a chat with its own model, at low reasoning when the model takes it. */
  title: ServerAIDefaults | null
  enabled: boolean
}
/** `GET /me/ai/models`: what the stored key reaches, or a curated list when there is no answer. */
export interface ServerAIModels {
  models: ChatModel[]
  source: 'api' | 'fallback'
  error?: string
}
export interface LearningChat {
  id: string
  kind: ContentKind
  contentId: string
  version: string
  title: string
  createdAt: string
  messages?: number
  lastMessageAt?: string
  running?: boolean
}
export interface LearningMessage {
  id: string
  chatId: string
  role: 'user' | 'assistant'
  text: string
  status: 'complete' | 'running' | 'interrupted' | 'error' | 'cancelled'
  at: string
  quote?: string
  model?: string
  reasoning?: ReasoningEffort | null
  activity?: { label: string; running: boolean } | null
  citations: { title: string; url?: string; start?: number; end?: number; page?: number; moduleId?: string; lessonId?: string }[]
}
export interface LearningChatView {
  chat: LearningChat
  messages: LearningMessage[]
}
export interface LearningStreamEvent {
  id: number
  messageId: string
  type: 'delta' | 'done' | 'activity'
  text?: string
  status?: LearningMessage['status']
}
export const learningKey = (kind: ContentKind, id: string): string => `${kind}:${id}`
export const SYNC_FIELDS =
  /^(lesson|quiz|exercise|code|project|review|position|readPage|lastItem|preference|reset)(:[a-zA-Z0-9_.:/-]{1,200})?$/
/**
 * `code:<exercise>` is the learner's own file for that exercise, so the web
 * editor and the desktop workspace open on the same text. Every other field is
 * a summary; this one is the work itself, and the only one allowed to be long.
 */
export const MAX_EXERCISE_CODE = 64000
export function newer(
  a: Pick<LearningField, 'at' | 'operation'>,
  b?: Pick<LearningField, 'at' | 'operation'>
): boolean {
  return !b || a.at > b.at || (a.at === b.at && a.operation > b.operation)
}
/** Bound hostile clocks; preserve normal offline action times rather than arrival order. */
export function actionTime(at: number, now: number): number {
  return Math.max(0, Math.min(Number.isFinite(at) ? at : now, now))
}
