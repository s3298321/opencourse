import type { ChatMessage, ChatSummary } from '../types'
export interface NotebookAssociation { kind: 'course' | 'document' | 'coach'; id: string; title: string }
export interface WritingNotebookPage { id: string; title: string; revision: number; markdown: string; updatedAt: string }
export interface WritingNotebookSummary {
  id: string; title: string; association?: NotebookAssociation; associationAvailable?: boolean
  createdAt: string; updatedAt: string; lastAccessedAt: string
}
export interface WritingNotebook extends WritingNotebookSummary {
  version: 1; pages: { id: string; title: string }[]; selectedPageId: string
  textScale: number; chatOpen: boolean; bounds?: { x: number; y: number; width: number; height: number }
  showLineNumbers?: boolean; textLayout?: 'wide' | 'thin'
  /** Derived from the on-disk folder tree on every read; never written to notebook.json. */
  tree?: WritingTreeNode[]
}
/** A node of the notebook's page tree. Folders and foreign files are identified by their
 *  relative path inside the tree root; pages keep their UUID identity wherever they sit. */
export type WritingTreeNode =
  | { kind: 'folder'; name: string; path: string; children: WritingTreeNode[] }
  | { kind: 'page'; id: string; title: string; path: string }
  | { kind: 'file'; name: string; path: string }
export interface WritingNotebookHit { notebook: WritingNotebookSummary; pageId?: string; pageTitle?: string; excerpt?: string; rank: number }
export type WritingNotebookSaveResult = { ok: true; page: WritingNotebookPage } | { ok: false; page: WritingNotebookPage }
export interface WritingNotebookChatSummary extends Omit<ChatSummary, 'courseId' | 'startedIn'> { notebookId: string; startedOn: string }
export interface WritingNotebookChatThread { chat: WritingNotebookChatSummary; messages: ChatMessage[] }
export interface WritingNotebookContext { notebookId: string; pageId: string; revision: number; title: string }
export const MAX_WRITING_PAGE_BYTES = 1024 * 1024
export const MAX_WRITING_PAGES = 500
export const WRITING_ASSET_HOST = 'writing-notebooks'
