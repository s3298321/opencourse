import type { ChatMessage, ChatSummary } from '../types'

export interface DocumentSection {
  id: string
  title: string
  page: number
  depth: number
  /** Distance from the top of the unscaled PDF page, when known. */
  top?: number
}
export interface DocumentSummary {
  id: string
  title: string
  bytes: number
  fingerprint: string
  pages: number
  indexedPages: number
  searchablePages: number
  status: 'indexing' | 'ready' | 'error'
  error: string | null
  completed: boolean
  createdAt: string
}
export interface DocumentView extends DocumentSummary { sections: DocumentSection[] }
export interface DocumentHit { page: number; excerpt: string }
export interface DocumentSearch {
  hits: DocumentHit[]
  indexedPages: number
  pages: number
  complete: boolean
  more: boolean
}
export type DocumentImportResult = { status: 'ok'; document: DocumentSummary; duplicate: boolean } | { status: 'cancelled' }
export interface DocumentChatSummary extends Omit<ChatSummary, 'courseId' | 'startedIn'> {
  documentId: string
  startedOn: number
}
export interface DocumentChatThread { chat: DocumentChatSummary; messages: ChatMessage[] }
export type ReadingSource =
  | { kind: 'document'; documentId: string; page: number; title: string }
  | { kind: 'course'; courseId: string; moduleId: string; lessonId?: string; title: string }

export const MAX_PDF_RANGE = 1024 * 1024
export const MAX_PAGE_TEXT = 64_000
export const DOCUMENT_INDEX_VERSION = 1
