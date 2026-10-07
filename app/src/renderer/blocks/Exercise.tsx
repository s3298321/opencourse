import { useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { ExerciseBlock } from '@core/types'
import Html from '../components/Html'

interface Props {
  courseId: string
  block: ExerciseBlock
  done: boolean
  onToggleDone: (blockId: string, done: boolean) => void
  onOpenWorkbench?: (blockId: string) => void
  isOpen?: boolean
  /**
   * `lesson` is the card in the lesson. `brief` is the same exercise in the
   * column beside the editor: the task stays readable while you write the
   * code, so it drops what the editor already has - the button that opens it
   * and the starter code, which is the buffer you are editing.
   * `preview` reads the solution from the course draft instead of learner storage.
   */
  mode?: 'lesson' | 'brief' | 'preview'
  starterFiles?: ReactNode
}

export default function ExerciseBlockView({
  courseId,
  block,
  done,
  onToggleDone,
  onOpenWorkbench,
  isOpen = false,
  mode = 'lesson',
  starterFiles
}: Props): JSX.Element {
  const [solution, setSolution] = useState<string | null>(null)
  const brief = mode === 'brief'

  const showSolution = async (): Promise<void> => {
    setSolution(mode === 'preview' ? block.solution ?? '' : await window.opencourse.getSolution(courseId, block.id))
  }

  return (
    <div className={brief ? 'exercise exercise-brief' : 'block card exercise'}>
      <h3>Exercise: {block.title}</h3>
      <Html className="prompt" source={block.prompt} />

      {starterFiles ?? (!brief && block.starter_code && (
        <details>
          <summary>Starter code</summary>
          <pre>
            <code>{block.starter_code}</code>
          </pre>
        </details>
      ))}

      <div className="verify">
        <strong>How to verify:</strong>{' '}
        <Html as="span" inline source={block.verification_instructions} />
      </div>

      {block.hints && block.hints.length > 0 && (
        <details>
          <summary>Hints ({block.hints.length})</summary>
          <ul>
            {block.hints.map((hint, i) => (
              <Html as="li" key={i} inline source={hint} />
            ))}
          </ul>
        </details>
      )}

      <div className="actions">
        {!brief && onOpenWorkbench && (
          <button onClick={() => onOpenWorkbench(block.id)} disabled={isOpen}>
            {isOpen ? 'Editor open →' : 'Open editor'}
          </button>
        )}
        <button className="secondary" onClick={() => void showSolution()} disabled={solution !== null}>
          Show solution
        </button>
        <button
          className={done ? 'secondary' : ''}
          onClick={() => onToggleDone(block.id, !done)}
          style={{ marginLeft: 'auto' }}
        >
          {done ? '✓ Completed' : 'Mark completed'}
        </button>
      </div>

      {solution !== null && (
        <details open>
          <summary>Reference solution</summary>
          <pre>
            <code>{(mode === 'preview' ? block.solution : solution) || 'This exercise has no reference solution yet.'}</code>
          </pre>
        </details>
      )}
    </div>
  )
}
