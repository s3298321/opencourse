import { describe, expect, it } from 'vitest'
import { grade, normalizeText } from '@core/grading'
import type { QuizBlock } from '@core/types'

const single: QuizBlock = {
  type: 'quiz', slug: 'q1', id: 'q1', kind: 'single', question: 'Which?',
  options: [
    { id: 'a', text: 'no', correct: false },
    { id: 'b', text: 'yes', correct: true },
    { id: 'c', text: 'no', correct: false }
  ]
}

const multiple: QuizBlock = {
  type: 'quiz', slug: 'q2', id: 'q2', kind: 'multiple', question: 'Which?',
  options: [
    { id: 'a', text: 'yes', correct: true },
    { id: 'b', text: 'no', correct: false },
    { id: 'c', text: 'yes', correct: true }
  ]
}

const text: QuizBlock = {
  type: 'quiz', slug: 'q3', id: 'q3', kind: 'text', question: 'Keyword?', answers: ['await', 'await keyword']
}

describe('single choice', () => {
  it('accepts the one correct option', () => {
    expect(grade(single, ['b'])).toEqual({ isCorrect: true, score: 1, correct: ['b'] })
  })
  it('rejects a wrong option', () => {
    expect(grade(single, ['a']).isCorrect).toBe(false)
  })
  it('rejects an empty submission', () => {
    expect(grade(single, []).isCorrect).toBe(false)
  })
  it('rejects picking everything', () => {
    expect(grade(single, ['a', 'b', 'c']).isCorrect).toBe(false)
  })
})

describe('multiple choice', () => {
  it('needs the exact set', () => {
    expect(grade(multiple, ['a', 'c']).isCorrect).toBe(true)
    expect(grade(multiple, ['c', 'a']).isCorrect).toBe(true)
  })
  it('rejects a subset', () => {
    expect(grade(multiple, ['a']).isCorrect).toBe(false)
  })
  it('rejects a superset', () => {
    expect(grade(multiple, ['a', 'b', 'c']).isCorrect).toBe(false)
  })
  it('ignores duplicates', () => {
    expect(grade(multiple, ['a', 'a', 'c']).isCorrect).toBe(true)
  })
})

describe('short answer', () => {
  it('matches case-insensitively', () => {
    expect(grade(text, ['AWAIT']).isCorrect).toBe(true)
  })
  it.each([
    '`await`',
    ' await ',
    'await.',
    'the await keyword',
    'The `await` keyword.'
  ])('is lenient about %s', (answer) => {
    expect(grade(text, [answer]).isCorrect).toBe(true)
  })
  it('still rejects a wrong answer', () => {
    expect(grade(text, ['yield']).isCorrect).toBe(false)
  })
  it('rejects an empty answer', () => {
    expect(grade(text, ['']).isCorrect).toBe(false)
    expect(grade(text, ['   ']).isCorrect).toBe(false)
  })
  it('normalizes the pieces it promises to', () => {
    expect(normalizeText('  The `Print()`.  ')).toBe('print')
  })
})
