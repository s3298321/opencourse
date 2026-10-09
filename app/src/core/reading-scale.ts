/**
 * The reader's text size, as a multiplier on every text size a lesson screen
 * shows: the lesson, the exercise brief and the side chat. It is the reader's
 * and nobody else's - a theme does not set type sizes at all, so applying one
 * never undoes this.
 *
 * Any whole percent from 50 to 200, typed into the control, or one of the steps
 * A− and A+ move between - the zoom levels a browser uses, so they feel
 * familiar. A hand-edited preferences.json cannot ask for 1% or 4000%.
 */
export const MIN_READING_SCALE = 0.5
export const MAX_READING_SCALE = 2

export const READING_SCALES = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const DEFAULT_READING_SCALE = 1

/** A whole percent within the range, or the default for anything that is not a usable number. */
export function normalizeReadingScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_READING_SCALE
  const clamped = Math.min(MAX_READING_SCALE, Math.max(MIN_READING_SCALE, value))
  return Math.round(clamped * 100) / 100
}

/**
 * The next step up (+1) or down (-1) from wherever the size is - a typed 130%
 * goes to 150% or 125% - stopping at either end.
 */
export function stepReadingScale(current: number, direction: 1 | -1): number {
  const at = normalizeReadingScale(current)
  const next = direction > 0
    ? READING_SCALES.find((step) => step > at + 0.001)
    : [...READING_SCALES].reverse().find((step) => step < at - 0.001)
  return next ?? at
}

export function canStepReadingScale(current: number, direction: 1 | -1): boolean {
  return stepReadingScale(current, direction) !== normalizeReadingScale(current)
}

/** "125%". */
export function formatReadingScale(scale: number): string {
  return `${Math.round(normalizeReadingScale(scale) * 100)}%`
}

/**
 * What the reader typed into the size, as a scale: "130", "130%", " 112.5 % ".
 * Null for anything that is not a number from 50 to 200 - the control then goes
 * back to the size it had.
 */
export function parseReadingPercent(text: string): number | null {
  const match = /^\s*(\d{1,3}(?:[.,]\d+)?)\s*%?\s*$/.exec(text)
  if (!match) return null
  const percent = Math.round(Number(match[1]!.replace(',', '.')))
  if (!Number.isFinite(percent) || percent < MIN_READING_SCALE * 100 || percent > MAX_READING_SCALE * 100) return null
  return percent / 100
}
