export const MAX_CELL_BYTES = 1024 * 1024
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const MAX_NOTEBOOK_CELLS = 500
export interface CellOutput { kind: 'stdout' | 'stderr'; text: string }
export interface CellExecution {
  runId: string
  generation: string
  count: number
  code: string
  status: 'running' | 'complete' | 'failed' | 'stopped'
  outputs: CellOutput[]
  truncated?: boolean
  at: string
}
export interface NotebookCell { id: string; content: string; execution?: CellExecution }
export interface NotebookDocument { version: 1; revision: number; cells: NotebookCell[] }
export type NotebookSaveResult = { ok: true; document: NotebookDocument } | { ok: false; document: NotebookDocument }
export interface NotebookStatus {
  enabled: boolean
  stage: 'idle' | 'creating' | 'ready' | 'failed'
  message?: string
  kernel: 'stopped' | 'starting' | 'stopping' | 'idle' | 'busy'
  generation?: string
  runningCellId?: string
}
export interface CellTarget { courseId: string; cellId: string; kind: 'notebook' | 'lesson' }
export interface CellRunRequest extends CellTarget { requestId: string }
export type NotebookEvent =
  | { type: 'status'; courseId: string; status: NotebookStatus }
  | { type: 'document'; courseId: string; document: NotebookDocument }
  | { type: 'execution'; target: CellRunRequest; execution: CellExecution }
