/**
 * The reader's text size: steps for A− and A+, and any whole percent from 50
 * to 200 typed into the control. A hand-edited preferences.json cannot ask for
 * 1% or 4000%.
 */
import { describe, expect, it } from 'vitest'
import {
  canStepReadingScale,
  DEFAULT_READING_SCALE,
  formatReadingScale,
  MAX_READING_SCALE,
  MIN_READING_SCALE,
  normalizeReadingScale,
  parseReadingPercent,
  READING_SCALES,
  stepReadingScale
} from '@core/reading-scale'
import { normalizePreferences } from '@core/preferences'

describe('reading scale', () => {
  it('has the app\'s own size and both ends among its steps, in order', () => {
    expect(READING_SCALES).toContain(DEFAULT_READING_SCALE)
    expect(READING_SCALES[0]).toBe(MIN_READING_SCALE)
    expect(READING_SCALES[READING_SCALES.length - 1]).toBe(MAX_READING_SCALE)
    expect([...READING_SCALES].sort((a, b) => a - b)).toEqual([...READING_SCALES])
  })

  it('keeps any whole percent in range, clamps the rest, and reads junk as the default', () => {
    expect(normalizeReadingScale(1.3)).toBe(1.3)
    expect(normalizeReadingScale(1.234)).toBe(1.23)
    expect(normalizeReadingScale(40)).toBe(MAX_READING_SCALE)
    expect(normalizeReadingScale(0.01)).toBe(MIN_READING_SCALE)
    for (const junk of [undefined, null, '1.25', NaN, Infinity, 0, -1, {}]) expect(normalizeReadingScale(junk)).toBe(1)
  })

  it('steps to the next step from wherever the size is, and stops at either end', () => {
    expect(stepReadingScale(1, 1)).toBe(1.1)
    expect(stepReadingScale(1.1, 1)).toBe(1.25)
    expect(stepReadingScale(1, -1)).toBe(0.9)
    // A typed size sits between steps; the arrows go to the neighbours.
    expect(stepReadingScale(1.3, 1)).toBe(1.5)
    expect(stepReadingScale(1.3, -1)).toBe(1.25)
    expect(stepReadingScale(MAX_READING_SCALE, 1)).toBe(MAX_READING_SCALE)
    expect(canStepReadingScale(MAX_READING_SCALE, 1)).toBe(false)
    expect(canStepReadingScale(MIN_READING_SCALE, -1)).toBe(false)
    expect(canStepReadingScale(1, 1)).toBe(true)
  })

  it('says itself as a percentage', () => {
    expect(formatReadingScale(1)).toBe('100%')
    expect(formatReadingScale(1.25)).toBe('125%')
    expect(formatReadingScale(0.67)).toBe('67%')
  })

  it('reads what the reader typed, and refuses anything outside 50 to 200', () => {
    expect(parseReadingPercent('130')).toBe(1.3)
    expect(parseReadingPercent(' 130 % ')).toBe(1.3)
    expect(parseReadingPercent('112.5')).toBe(1.13)
    expect(parseReadingPercent('112,4')).toBe(1.12)
    expect(parseReadingPercent('50')).toBe(0.5)
    expect(parseReadingPercent('200%')).toBe(2)
    for (const no of ['', '49', '201', '1000', '-120', 'big', '1.2.3', '12 0']) expect(parseReadingPercent(no), no).toBeNull()
  })

  it('is kept in preferences.json only when it is not the default', () => {
    expect(normalizePreferences({ readingScale: 1.25 }).readingScale).toBe(1.25)
    expect(normalizePreferences({ readingScale: 1.3 }).readingScale).toBe(1.3)
    expect(normalizePreferences({ readingScale: 9 }).readingScale).toBe(MAX_READING_SCALE)
    expect('readingScale' in normalizePreferences({ readingScale: 1 })).toBe(false)
    expect('readingScale' in normalizePreferences({ readingScale: 'huge' })).toBe(false)
    expect('readingScale' in normalizePreferences({})).toBe(false)
  })
})
