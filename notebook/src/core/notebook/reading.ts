import type { NotebookDocument } from './types'
import { boundedResult, nonnegativeInteger, toolArguments, type RetrievalBudget } from '../reading/tools'

export function readNotebookCells(notebook: NotebookDocument, raw: unknown, budget: RetrievalBudget): string {
  const args = toolArguments(raw), cursor = nonnegativeInteger(args.cursor), offset = nonnegativeInteger(args.offset)
  const cell = notebook.cells[cursor]
  if (!cell) return boundedResult({ cells: [], nextCursor: null }, budget)
  const text = `Code:\n${cell.content}\nSaved output (${cell.execution?.status ?? 'not run'}${cell.execution && cell.execution.code !== cell.content ? ', source has changed' : ''}):\n${cell.execution?.outputs.map(output => output.text).join('') ?? ''}`
  const passage = text.slice(offset, offset + 6000)
  return boundedResult({ source: `Notebook cell ${cursor + 1}`, cellId: cell.id, text: passage,
    nextOffset: offset + passage.length < text.length ? offset + passage.length : null,
    nextCursor: cursor + 1 < notebook.cells.length ? cursor + 1 : null, revision: notebook.revision }, budget)
}
