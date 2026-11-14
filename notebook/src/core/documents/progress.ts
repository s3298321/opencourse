import type { DocumentSummary } from './types'

export function documentProgressPercent({ pages, readPage }: Pick<DocumentSummary, 'pages' | 'readPage'>): number {
  return pages > 0 ? Math.floor(Math.min(pages, Math.max(0, readPage)) / pages * 100) : 0
}
