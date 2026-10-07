/** Quiz grading. Ported from apps/courses/grading.py. */
import type { GradeResult, QuizBlock } from './types'

/**
 * Short-answer answers are compared leniently: case, surrounding whitespace,
 * markdown backticks, a trailing "()", trailing punctuation and a leading
 * article are all ignored. "The `await` keyword." and "await" both match an
 * accepted answer of "await keyword" / "await" respectively.
 */
export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[.!?,;:]+$/, '')
    .replace(/\(\s*\)$/, '')
    .replace(/^(a|an|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function findQuiz(blocks: { type: string; id?: string }[], blockId: string): QuizBlock | undefined {
  return blocks.find((b) => b.type === 'quiz' && b.id === blockId) as QuizBlock | undefined
}

export function grade(quiz: QuizBlock, submitted: string[]): GradeResult {
  if (quiz.kind === 'text') {
    const accepted = (quiz.answers ?? []).map(normalizeText)
    const got = normalizeText(submitted[0] ?? '')
    const isCorrect = got.length > 0 && accepted.includes(got)
    return { isCorrect, score: isCorrect ? 1 : 0, correct: quiz.answers ?? [] }
  }

  const options = quiz.options ?? []
  const correct = options.filter((o) => o.correct).map((o) => o.id).sort()
  const given = [...new Set(submitted)].sort()

  // single: exactly one correct option, and it is the one that was picked.
  // multiple: the sets must match exactly.
  const isCorrect =
    quiz.kind === 'single'
      ? given.length === 1 && correct.length === 1 && given[0] === correct[0]
      : given.length === correct.length && given.every((id, i) => id === correct[i])

  return { isCorrect, score: isCorrect ? 1 : 0, correct }
}
