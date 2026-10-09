/**
 * The reader's text size, as a multiplier on every text size a lesson screen
 * shows: the lesson, the exercise brief and the side chat. It is the reader's
 * and nobody else's - a theme does not set type sizes at all, so applying one
 * never undoes this.
 *
 * Steps rather than a free number, so A− and A+ always land on the same sizes
 * and a hand-edited preferences.json cannot ask for 0.01 or 40.
 */
export const READING_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8] as const

export const DEFAULT_READING_SCALE = 1

/** The nearest step to `value`, or the default for anything that is not a usable number. */
export function normalizeReadingScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_READING_SCALE
  let best: number = DEFAULT_READING_SCALE
  for (const step of READING_SCALES) if (Math.abs(step - value) < Math.abs(best - value)) best = step
  return best
}

/** One step larger (+1) or smaller (-1), stopping at either end. */
export function stepReadingScale(current: number, direction: 1 | -1): number {
  const index = READING_SCALES.indexOf(normalizeReadingScale(current) as typeof READING_SCALES[number])
  const next = Math.min(READING_SCALES.length - 1, Math.max(0, index + direction))
  return READING_SCALES[next]!
}

export function canStepReadingScale(current: number, direction: 1 | -1): boolean {
  return stepReadingScale(current, direction) !== normalizeReadingScale(current)
}

/** "125%". */
export function formatReadingScale(scale: number): string {
  return `${Math.round(normalizeReadingScale(scale) * 100)}%`
}
