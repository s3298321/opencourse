import type { JSX } from 'react'
import type { Lesson } from '@core/types'

export default function LessonHeader({ lesson, index, total }: { lesson: Omit<Lesson, 'flashcards'>; index: number; total: number }): JSX.Element {
  return <>
    <div className="lesson-head">
      <div className="meta">Lesson {index + 1} of {total}{lesson.estimated_minutes ? ` · about ${lesson.estimated_minutes} minutes` : ''}</div>
      <h1>{lesson.title}</h1>
    </div>
    {!!lesson.objectives?.length && <div className="objectives">
      <h2>By the end of this lesson you can</h2>
      <ul>{lesson.objectives.map((objective, i) => <li key={i}>{objective}</li>)}</ul>
    </div>}
  </>
}
