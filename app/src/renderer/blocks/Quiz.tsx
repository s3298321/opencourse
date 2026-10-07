import { useId, useState } from 'react'
import type { JSX } from 'react'
import type { QuizAttempt, QuizBlock } from '@core/types'
import Html from '../components/Html'
import { grade } from '@core/grading'

interface Props {
  courseId: string
  block: QuizBlock
  attempt?: QuizAttempt
  onAnswered: (blockId: string, attempt: QuizAttempt) => void
  /** Try the current draft without writing learner progress. */
  preview?: boolean
}

interface Verdict {
  isCorrect: boolean
  correct: string[]
  explanation?: string
}

export default function QuizBlockView({ courseId, block, attempt, onAnswered, preview = false }: Props): JSX.Element {
  const group = useId()
  const [selected, setSelected] = useState<string[]>(attempt?.submitted ?? [])
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!selected.length || !selected.some((s) => s.trim())) return
    setBusy(true)
    try {
      const result = preview ? { ...grade(block, selected), explanation: block.explanation } : await window.opencourse.submitQuiz(courseId, block.id, selected)
      setVerdict({ isCorrect: result.isCorrect, correct: result.correct, explanation: result.explanation })
      onAnswered(block.id, { submitted: selected, isCorrect: result.isCorrect, at: new Date().toISOString() })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    setVerdict(null)
    setSelected((prev) =>
      block.kind === 'multiple'
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id]
    )
  }

  const answeredEarlier = !verdict && attempt

  return (
    <div className="block card quiz">
      <Html className="question" inline source={block.question} />

      {block.kind === 'text' ? (
        <input
          type="text"
          value={selected[0] ?? ''}
          placeholder="Your answer"
          onChange={(e) => {
            setVerdict(null)
            setSelected([e.target.value])
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      ) : (
        block.options?.map((option) => (
          <label key={option.id}>
            <input
              type={block.kind === 'multiple' ? 'checkbox' : 'radio'}
              name={`quiz-${group}`}
              checked={selected.includes(option.id)}
              onChange={() => toggle(option.id)}
            />
            <Html as="span" inline source={option.text} />
          </label>
        ))
      )}

      <div className="actions">
        <button onClick={() => void submit()} disabled={busy || selected.length === 0}>
          {block.kind === 'multiple' ? 'Check answers' : 'Check answer'}
        </button>
        {answeredEarlier && (
          <span className="meta">
            Last attempt: {attempt?.isCorrect ? 'correct' : 'incorrect'}
          </span>
        )}
      </div>

      {verdict && (
        <div className={`feedback ${verdict.isCorrect ? 'ok' : 'err'}`}>
          <strong>{verdict.isCorrect ? 'Correct.' : 'Not quite.'}</strong>
          {verdict.explanation && (
            <Html className="explanation" inline source={verdict.explanation} />
          )}
        </div>
      )}
    </div>
  )
}
