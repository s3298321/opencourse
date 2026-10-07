import { describe, expect, it } from 'vitest'
import { buildCourse } from '@core/manifest'
import {
  emptyProgress,
  normalizeProgress,
  recordExerciseRun,
  recordQuizAttempt,
  setExerciseDone,
  summarizeProgress,
  toggleLesson,
  touchLesson
} from '@core/progress'
import type { CourseManifest } from '@core/types'

const manifest: CourseManifest = {
  schema_version: '1.1',
  slug: 'demo',
  title: 'Demo',
  modules: [
    {
      slug: 'm',
      title: 'M',
      lessons: [
        {
          slug: 'a',
          title: 'A',
          blocks: [
            { type: 'quiz', slug: 'q1', id: 'q1', kind: 'text', question: '?', answers: ['x'] },
            { type: 'quiz', slug: 'q2', id: 'q2', kind: 'text', question: '?', answers: ['x'] },
            { type: 'exercise', slug: 'e1', id: 'e1', title: 'E', prompt: 'p', verification_instructions: 'v' }
          ]
        },
        { slug: 'b', title: 'B', blocks: [] }
      ]
    }
  ]
}
const course = buildCourse(manifest, '/tmp/demo')

describe('lesson completion', () => {
  it('toggles on and back off', () => {
    const on = toggleLesson(emptyProgress('demo'), 'm', 'a')
    expect(on.completedLessons).toEqual(['m/a'])
    expect(toggleLesson(on, 'm', 'a').completedLessons).toEqual([])
  })

  it('records where the learner was', () => {
    const p = touchLesson(emptyProgress('demo'), 'm', 'b')
    expect(p.lastLesson).toEqual({ moduleId: 'm', lessonId: 'b' })
    expect(p.lastAccessed).toBeTypeOf('string')
  })
})

describe('quizzes and exercises', () => {
  it('keeps only the latest attempt per quiz', () => {
    let p = recordQuizAttempt(emptyProgress('demo'), 'q1', { submitted: ['a'], isCorrect: false, at: '1' })
    p = recordQuizAttempt(p, 'q1', { submitted: ['b'], isCorrect: true, at: '2' })
    expect(Object.keys(p.quizAttempts)).toEqual(['q1'])
    expect(p.quizAttempts.q1.isCorrect).toBe(true)
  })

  it('marks and unmarks an exercise', () => {
    const done = setExerciseDone(emptyProgress('demo'), 'e1', true)
    expect(done.exercises.e1.completedAt).toBeTypeOf('string')
    expect(setExerciseDone(done, 'e1', false).exercises).toEqual({})
  })
})

describe('summarizeProgress', () => {
  it('counts against the course, not the file', () => {
    let p = toggleLesson(emptyProgress('demo'), 'm', 'a')
    p = recordQuizAttempt(p, 'q1', { submitted: ['x'], isCorrect: true, at: '1' })
    p = recordQuizAttempt(p, 'q2', { submitted: ['y'], isCorrect: false, at: '1' })
    p = setExerciseDone(p, 'e1', true)

    expect(summarizeProgress(course, p)).toEqual({
      lessonsDone: 1,
      lessonsTotal: 2,
      quizzesCorrect: 1,
      quizzesTotal: 2,
      exercisesDone: 1,
      exercisesTotal: 1,
      projectsDone: 0,
      projectsTotal: 0,
      percent: 50
    })
  })

  it('ignores progress for lessons the course no longer has', () => {
    const p = { ...emptyProgress('demo'), completedLessons: ['m/a', 'm/removed'] }
    expect(summarizeProgress(course, p).lessonsDone).toBe(1)
  })
})

describe('normalizeProgress', () => {
  it.each([null, undefined, 42, 'nope', [], {}])('survives %s on disk', (raw) => {
    expect(normalizeProgress('demo', raw)).toEqual(emptyProgress('demo'))
  })

  it('drops junk but keeps good values', () => {
    const p = normalizeProgress('demo', {
      completedLessons: ['m/a', 7, null],
      lastLesson: { moduleId: 'm' },
      quizAttempts: { q1: { submitted: ['x'], isCorrect: true, at: '1' } }
    })
    expect(p.completedLessons).toEqual(['m/a'])
    expect(p.lastLesson).toBeUndefined()
    expect(p.quizAttempts.q1.isCorrect).toBe(true)
  })
})

describe('recordExerciseRun', () => {
  const base = emptyProgress('c')

  it('completes the exercise on a green run', () => {
    const next = recordExerciseRun(base, 'ex-1', true, new Date('2026-01-01T00:00:00Z'))
    expect(next.exercises['ex-1']?.completedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(next.exercises['ex-1']?.lastRun).toEqual({ at: '2026-01-01T00:00:00.000Z', passed: true })
  })

  it('records a red run without completing it', () => {
    const next = recordExerciseRun(base, 'ex-1', false)
    expect(next.exercises['ex-1']?.completedAt).toBeUndefined()
    expect(next.exercises['ex-1']?.lastRun?.passed).toBe(false)
  })

  it('never un-completes work after a later failure', () => {
    const passed = recordExerciseRun(base, 'ex-1', true, new Date('2026-01-01T00:00:00Z'))
    const failed = recordExerciseRun(passed, 'ex-1', false, new Date('2026-01-02T00:00:00Z'))
    expect(failed.exercises['ex-1']?.completedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(failed.exercises['ex-1']?.lastRun?.passed).toBe(false)
  })

  it('keeps the original completion time across repeated passes', () => {
    const first = recordExerciseRun(base, 'ex-1', true, new Date('2026-01-01T00:00:00Z'))
    const again = recordExerciseRun(first, 'ex-1', true, new Date('2026-03-01T00:00:00Z'))
    expect(again.exercises['ex-1']?.completedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('an entry that only has a run does not count as done', () => {
    const next = recordExerciseRun(base, 'ex-1', false)
    // The presence of the entry must never be mistaken for completion.
    expect(Boolean(next.exercises['ex-1'])).toBe(true)
    expect(Boolean(next.exercises['ex-1']?.completedAt)).toBe(false)
  })
})

describe('setExerciseDone merging', () => {
  it('does not discard the last run when marking done by hand', () => {
    const ran = recordExerciseRun(emptyProgress('c'), 'ex-1', false)
    const done = setExerciseDone(ran, 'ex-1', true)
    expect(done.exercises['ex-1']?.lastRun?.passed).toBe(false)
    expect(done.exercises['ex-1']?.completedAt).toBeTruthy()
  })
})
