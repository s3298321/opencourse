import { useEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { canStepReadingScale, formatReadingScale, parseReadingPercent, stepReadingScale } from '@core/reading-scale'

/**
 * The reader's text size, floating at the foot of the lesson column: larger,
 * the size itself, smaller. Press the size to type one - any whole percent from
 * 50 to 200; anything else, or Escape, puts back the size it had.
 *
 * A press must not take the selection with it. The document's mouseup is what
 * offers "Ask about this" for highlighted text, and a mousedown here would
 * otherwise collapse the selection or re-place the offer at the size the text
 * was before - so the buttons refuse focus-by-mouse the way the offer does, and
 * stay reachable from the keyboard. The field is the exception: typing in it
 * needs the focus.
 */
export default function ReadingSize({
  scale,
  onChange
}: {
  scale: number
  onChange: (scale: number) => void
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  // What is being typed, read by commit: the field can blur as it is removed,
  // after Escape, and a stale render's value must not be applied then.
  const typed = useRef<string | null>(null)
  const edit = (value: string | null): void => { typed.current = value; setEditing(value) }

  useEffect(() => {
    if (editing === null) return
    field.current?.focus()
    field.current?.select()
    // Only when editing starts, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing === null])

  const commit = (): void => {
    if (typed.current === null) return
    const next = parseReadingPercent(typed.current)
    edit(null)
    if (next !== null && next !== scale) onChange(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit() }
    if (event.key === 'Escape') { event.preventDefault(); edit(null) }
  }

  return (
    <div className="reading-size-strip">
      <div
        className="reading-size"
        role="group"
        aria-label="Text size"
        onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault() }}
      >
        <button
          className="reading-size-larger"
          aria-label="Larger text"
          title="Larger text"
          disabled={!canStepReadingScale(scale, 1)}
          onClick={() => onChange(stepReadingScale(scale, 1))}
        >
          A<span aria-hidden="true">+</span>
        </button>
        {editing === null ? (
          <button
            className="reading-size-value"
            title="Type a text size"
            aria-label={`Text size ${formatReadingScale(scale)}. Press to type a size`}
            onClick={() => edit(String(Math.round(scale * 100)))}
          >
            {formatReadingScale(scale)}
          </button>
        ) : (
          <input
            ref={field}
            className="reading-size-field"
            type="text"
            inputMode="numeric"
            maxLength={5}
            aria-label="Text size in percent, from 50 to 200"
            value={editing}
            onChange={(event) => edit(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
          />
        )}
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
