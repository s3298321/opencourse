import type { JSX } from 'react'
import type { Lesson } from '@core/types'
import Objectives from './Objectives'

export default function LessonHeader({ lesson, index, total }: { lesson: Omit<Lesson, 'flashcards'>; index: number; total: number }): JSX.Element {
  return <>
    <div className="lesson-head">
      <div className="meta">Lesson {index + 1} of {total}{lesson.estimated_minutes ? ` · ${lesson.estimated_minutes} minutes` : ''}</div>
      <h1>{lesson.title}</h1>
    </div>
    <Objectives title="By the end of this lesson you can" objectives={lesson.objectives} />
  </>
}
