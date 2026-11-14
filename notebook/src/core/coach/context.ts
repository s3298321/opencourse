/** On-demand, read-only renderer requests. No context is persisted between calls. */
export interface CoachContextRequest {
  requestId: string
  userId: string
  tool: 'get_app_context' | 'read_notebook_page' | 'read_notebook_cells'
  args: Record<string, unknown>
}
export interface CoachOpenContent {
  kind: 'screen' | 'lesson' | 'document' | 'notebook' | 'writing-notebook'
  visible: boolean
  title?: string
  screen?: string
  source?: { id: string; server_id: null; version: null }
  moduleId?: string
  lessonId?: string
  page?: number
  notebookId?: string
  pageId?: string
  pageTitle?: string
  selectedText?: string
  selectionTruncated?: boolean
  selectionPage?: number
  cellId?: string
  excerpt?: string
  excerptTruncated?: boolean
  unsaved?: boolean
}
export interface CoachContextReply { entries?: CoachOpenContent[]; value?: unknown; error?: string }
