/**
 * What one level of indentation is in a piece of code, read off the code.
 *
 * The editor needs this because CodeMirror's language indenters compute "the
 * block's indent plus one unit", and the unit defaults to two spaces - so Enter
 * inside a four-space C body landed two columns short, and inside a tabbed one
 * produced spaces. The learner's file is the authority on its own style; the
 * toolchain's `indentUnit` is only the fallback for a file with nothing
 * indented yet.
 */

/** The space widths worth recognising. Anything else is a typo, not a style. */
const WIDTHS = [2, 4, 8] as const

export function detectIndentUnit(text: string): string | null {
  let tabbed = 0
  let spaced = 0
  // How often each width is the step from the previous indented line. Steps,
  // not absolute depths: a file that is all eight-space bodies inside
  // four-space blocks is a four-space file.
  const steps = new Map<number, number>()
  let previous = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
    if (lead.startsWith('\t')) {
      tabbed += 1
      continue
    }
    const width = lead.length
    if (width > 0) spaced += 1
    const step = Math.abs(width - previous)
    previous = width
    if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1)
  }

  if (tabbed === 0 && spaced === 0) return null
  if (tabbed >= spaced) return '\t'

  let best: number | null = null
  for (const width of WIDTHS) {
    const seen = steps.get(width) ?? 0
    if (seen > 0 && (best === null || seen > (steps.get(best) ?? 0))) best = width
  }
  return best === null ? null : ' '.repeat(best)
}
