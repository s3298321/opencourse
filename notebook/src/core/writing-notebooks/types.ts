import type { ChatMessage, ChatSummary } from '../types'
export interface NotebookAssociation { kind: 'course' | 'document' | 'coach'; id: string; title: string }
/** A page file's content. The page has no title property: its title is its file name. */
export interface WritingNotebookPage { id: string; revision: number; markdown: string; updatedAt: string }
export interface WritingNotebookSummary {
  id: string; title: string; association?: NotebookAssociation; associationAvailable?: boolean
  createdAt: string; updatedAt: string; lastAccessedAt: string
}
export interface WritingNotebook extends WritingNotebookSummary {
  version: 1; pages: { id: string; path: string }[]; selectedPageId: string
  textScale: number; chatOpen: boolean; bounds?: { x: number; y: number; width: number; height: number }
  showLineNumbers?: boolean; textLayout?: 'wide' | 'thin'
  /** Derived from the on-disk folder tree on every read; never written to notebook.json. */
  tree?: WritingTreeNode[]
}
/** A node of the notebook's page tree. Folders and foreign files are identified by their
 *  relative path inside the tree root; a page keeps its UUID identity wherever its file
 *  sits, and its title is the file name (see pageTitle in tree.ts). */
export type WritingTreeNode =
  | { kind: 'folder'; name: string; path: string; children: WritingTreeNode[] }
  | { kind: 'page'; id: string; path: string }
  | { kind: 'file'; name: string; path: string }
export interface WritingNotebookHit { notebook: WritingNotebookSummary; pageId?: string; pageTitle?: string; excerpt?: string; rank: number }
export type WritingNotebookSaveResult = { ok: true; page: WritingNotebookPage } | { ok: false; page: WritingNotebookPage }
export interface WritingNotebookChatSummary extends Omit<ChatSummary, 'courseId' | 'startedIn'> { notebookId: string; startedOn: string }
export interface WritingNotebookChatThread { chat: WritingNotebookChatSummary; messages: ChatMessage[] }
export interface WritingNotebookContext { notebookId: string; pageId: string; revision: number; title: string }
export const MAX_WRITING_PAGE_BYTES = 1024 * 1024
export const MAX_WRITING_PAGES = 500
/* Caps for files dragged in from outside the notebook. */
export const MAX_WRITING_FILE_BYTES = 200 * 1024 * 1024
export const MAX_WRITING_IMPORT_FILES = 100
/** Non-page files above this are not opened as text; the viewer shows a warning card instead. */
export const MAX_WRITING_TEXT_BYTES = 5 * 1024 * 1024
/** What reading a non-page file produced: editable text, or a refusal that still reports the size. */
export type WritingFileRead = { kind: 'text'; text: string; bytes: number } | { kind: 'binary'; bytes: number } | { kind: 'large'; bytes: number }
export const WRITING_ASSET_HOST = 'writing-notebooks'
