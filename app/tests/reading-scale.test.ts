/**
 * The reader's text size. Steps, not a free number: A− and A+ always land on
 * the same sizes, and a hand-edited preferences.json cannot ask for 0.01.
 */
import { describe, expect, it } from 'vitest'
import {
  canStepReadingScale,
  DEFAULT_READING_SCALE,
  formatReadingScale,
  normalizeReadingScale,
  READING_SCALES,
  stepReadingScale
} from '@core/reading-scale'
import { normalizePreferences } from '@core/preferences'

describe('reading scale', () => {
  it('has the app\'s own size among its steps, in order', () => {
    expect(READING_SCALES).toContain(DEFAULT_READING_SCALE)
    expect([...READING_SCALES].sort((a, b) => a - b)).toEqual([...READING_SCALES])
  })

  it('snaps to the nearest step, and reads anything unusable as the default', () => {
    expect(normalizeReadingScale(1.24)).toBe(1.25)
    expect(normalizeReadingScale(1.05)).toBe(1)
    expect(normalizeReadingScale(40)).toBe(READING_SCALES[READING_SCALES.length - 1])
    expect(normalizeReadingScale(0.01)).toBe(READING_SCALES[0])
    for (const junk of [undefined, null, '1.25', NaN, Infinity, 0, -1, {}]) expect(normalizeReadingScale(junk)).toBe(1)
  })

  it('steps one size at a time and stops at either end', () => {
    expect(stepReadingScale(1, 1)).toBe(1.1)
    expect(stepReadingScale(1.1, 1)).toBe(1.25)
    expect(stepReadingScale(1, -1)).toBe(0.9)
    const largest = READING_SCALES[READING_SCALES.length - 1]!
    expect(stepReadingScale(largest, 1)).toBe(largest)
    expect(canStepReadingScale(largest, 1)).toBe(false)
    expect(canStepReadingScale(READING_SCALES[0], -1)).toBe(false)
    expect(canStepReadingScale(1, 1)).toBe(true)
  })

  it('says itself as a percentage', () => {
    expect(formatReadingScale(1)).toBe('100%')
    expect(formatReadingScale(1.25)).toBe('125%')
    expect(formatReadingScale(0.9)).toBe('90%')
  })

  it('is kept in preferences.json only when it is not the default', () => {
    expect(normalizePreferences({ readingScale: 1.25 }).readingScale).toBe(1.25)
    expect(normalizePreferences({ readingScale: 1.3 }).readingScale).toBe(1.25)
    expect('readingScale' in normalizePreferences({ readingScale: 1 })).toBe(false)
    expect('readingScale' in normalizePreferences({ readingScale: 'huge' })).toBe(false)
    expect('readingScale' in normalizePreferences({})).toBe(false)
  })
})
