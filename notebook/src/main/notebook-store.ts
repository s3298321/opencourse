/** Atomic learner state, independent from authored course JSON. No Electron dependency. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_CELL_BYTES, MAX_NOTEBOOK_CELLS, MAX_OUTPUT_BYTES, type NotebookCell, type NotebookDocument, type NotebookSaveResult, type CellExecution } from '../core/notebook/types'
import type { NotebookDeclaration } from '../core/types'

export function validateCellInputs(cells: { id: string; content: string }[]): void {
  if (!Array.isArray(cells) || cells.length > MAX_NOTEBOOK_CELLS) throw new Error(`A notebook supports up to ${MAX_NOTEBOOK_CELLS} cells.`)
  const ids = new Set<string>()
  for (const cell of cells) {
    if (!cell || typeof cell.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(cell.id) || ids.has(cell.id)) throw new Error('Invalid or duplicate notebook cell identity.')
    if (typeof cell.content !== 'string' || Buffer.byteLength(cell.content) > MAX_CELL_BYTES) throw new Error('Cell source exceeds the 1 MiB limit.')
    ids.add(cell.id)
  }
}
export function writeNotebook(path: string, document: NotebookDocument): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, JSON.stringify(document)); renameSync(tmp, path) }
  finally { rmSync(tmp, { force: true }) }
}
export function readNotebook(path: string): NotebookDocument {
  try {
    const document = JSON.parse(readFileSync(path, 'utf8')) as NotebookDocument
    if (document.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error('Invalid notebook version or revision.')
    validateCellInputs(document.cells)
    for (const cell of document.cells) if (cell.execution) {
      const run = cell.execution
      if (!['running', 'complete', 'failed', 'stopped'].includes(run.status) || typeof run.code !== 'string' || typeof run.runId !== 'string' || typeof run.generation !== 'string' || !Number.isSafeInteger(run.count) || typeof run.at !== 'string' || !Array.isArray(run.outputs) || run.outputs.some(output => !output || !['stdout', 'stderr'].includes(output.kind) || typeof output.text !== 'string') || Buffer.byteLength(run.code) > MAX_CELL_BYTES || run.outputs.reduce((sum, output) => sum + Buffer.byteLength(output.text), 0) > MAX_OUTPUT_BYTES) throw new Error('Invalid saved execution.')
    }
    return document
  } catch (error) {
    throw new Error(`The saved notebook could not be read. It has been preserved at ${path}. Restore it from a backup before retrying. ${(error as Error).message}`)
  }
}
export function initializeNotebook(path: string, declaration?: NotebookDeclaration): NotebookDocument {
  if (existsSync(path)) return readNotebook(path)
  const cells = declaration?.cells?.length ? declaration.cells : [{ content: '' }]
  const document: NotebookDocument = { version: 1, revision: 0, cells: cells.map(cell => ({ id: randomUUID(), content: cell.content })) }
  validateCellInputs(document.cells)
  writeNotebook(path, document)
  return document
}
export function saveNotebookCells(path: string, revision: number, cells: { id: string; content: string }[]): NotebookSaveResult {
  validateCellInputs(cells)
  const previous = readNotebook(path)
  if (previous.revision !== revision) return { ok: false, document: previous }
  const old = new Map(previous.cells.map(cell => [cell.id, cell]))
  const document: NotebookDocument = { version: 1, revision: revision + 1, cells: cells.map(cell => ({ id: cell.id, content: cell.content, ...(old.get(cell.id)?.execution ? { execution: old.get(cell.id)!.execution } : {}) })) }
  writeNotebook(path, document)
  return { ok: true, document }
}
export function recordCellExecution(path: string, cellId: string, execution?: CellExecution): NotebookDocument {
  const document = readNotebook(path)
  const cell: NotebookCell | undefined = document.cells.find(cell => cell.id === cellId)
  if (!cell) return document // A deleted running cell must never be recreated.
  if (execution) cell.execution = structuredClone(execution)
  else delete cell.execution
  document.revision++
  writeNotebook(path, document)
  return document
}
