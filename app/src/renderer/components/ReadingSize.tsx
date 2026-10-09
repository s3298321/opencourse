import type { JSX } from 'react'
import { canStepReadingScale, DEFAULT_READING_SCALE, formatReadingScale, stepReadingScale } from '@core/reading-scale'

/**
 * The reader's text size, floating at the foot of the lesson column: larger,
 * the size itself (press it to go back to the app's own), smaller.
 *
 * A press must not take the selection with it. The document's mouseup is what
 * offers "Ask about this" for highlighted text, and a mousedown here would
 * otherwise collapse the selection or re-place the offer at the size the text
 * was before - so the pill refuses focus-by-mouse the way the offer does, and
 * stays reachable from the keyboard.
 */
export default function ReadingSize({
  scale,
  onChange
}: {
  scale: number
  onChange: (scale: number) => void
}): JSX.Element {
  return (
    <div className="reading-size-strip">
      <div className="reading-size" role="group" aria-label="Text size" onMouseDown={(event) => event.preventDefault()}>
        <button
          className="reading-size-larger"
          aria-label="Larger text"
          title="Larger text"
          disabled={!canStepReadingScale(scale, 1)}
          onClick={() => onChange(stepReadingScale(scale, 1))}
        >
          A<span aria-hidden="true">+</span>
        </button>
        <button
          className="reading-size-reset"
          title="Reset text size"
          aria-label={`Text size ${formatReadingScale(scale)}. Reset`}
          disabled={scale === DEFAULT_READING_SCALE}
          onClick={() => onChange(DEFAULT_READING_SCALE)}
        >
          {formatReadingScale(scale)}
        </button>
        <button
          className="reading-size-smaller"
          aria-label="Smaller text"
          title="Smaller text"
          disabled={!canStepReadingScale(scale, -1)}
          onClick={() => onChange(stepReadingScale(scale, -1))}
        >
          A<span aria-hidden="true">−</span>
        </button>
      </div>
    </div>
  )
}
