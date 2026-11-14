import type { DocumentSection } from './types'
import { MAX_PAGE_TEXT } from './types'

export interface PdfTextItem { str: string; transform: number[]; hasEOL?: boolean; width: number; height: number }
/** Preserve line breaks, including PDFs that omit hasEOL, without joining words. */
export function pageText(items: readonly PdfTextItem[]): string {
  let text = '', last: PdfTextItem | undefined
  for (const item of items) {
    if (last && !text.endsWith('\n')) {
      const lineChanged = Math.abs(item.transform[5]! - last.transform[5]!) > Math.max(2, last.height * 0.35)
      text += lineChanged ? '\n' : ' '
    }
    text += item.str
    if (item.hasEOL) text += '\n'
    last = item
    if (text.length >= MAX_PAGE_TEXT) break
  }
  return text.trim().slice(0, MAX_PAGE_TEXT)
}

/** Conservative fallback for untagged PDFs; bookmarks always take precedence. */
export function pageHeadings(items: readonly PdfTextItem[], page: number, height: number): DocumentSection[] {
  const sizes = items.filter(item => item.str.trim().length > 3).map(item => ({ size: Math.hypot(item.transform[2]!, item.transform[3]!), weight: item.str.length })).sort((a, b) => a.size - b.size)
  let remaining = sizes.reduce((sum, entry) => sum + entry.weight, 0) / 2
  const body = sizes.find(entry => { remaining -= entry.weight; return remaining <= 0 })?.size ?? 0
  if (!body) return []
  const lines: { text: string; size: number; y: number }[] = []
  for (const item of items) {
    const text = item.str.trim(), size = Math.hypot(item.transform[2]!, item.transform[3]!)
    if (!text || size < body * 1.25) continue
    const previous = lines.at(-1)
    if (previous && Math.abs(previous.y - item.transform[5]!) < 2 && Math.abs(previous.size - size) < 1) previous.text += ` ${text}`
    else lines.push({ text, size, y: item.transform[5]! })
  }
  return lines.filter(line => line.text.length >= 3 && line.text.length <= 160 && !/^\d+$/.test(line.text)).slice(0, 30)
    .map((line, index) => ({ id: `heading-${page}-${index}`, title: line.text, page, depth: line.size >= body * 1.7 ? 0 : 1, top: Math.max(0, height - line.y - line.size) }))
}

/** FTS operators are not user input. Search plain words, with prefix matching. */
export function fullTextQuery(query: string): string | null {
  const words = query.slice(0, 300).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12)
  return words?.length ? words.map(word => `"${word}"*`).join(' AND ') : null
}
