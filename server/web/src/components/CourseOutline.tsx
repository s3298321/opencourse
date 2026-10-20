import { useState } from 'react'
import { ArrowLeft, ChevronDown, Monitor } from 'lucide-react'
import { Link } from 'react-router'
import type { CourseView } from '@core/types'
import type { LearningState } from '@core/learning/types'

export function CourseOutline({
  course,
  state,
  current,
  onNavigate
}: {
  course: CourseView
  state: LearningState
  current: number
  onNavigate: (index: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <aside className="course-reading-outline" data-expanded={expanded}>
      <header className="outline-course-header">
        <Link className="back-link" to={`/learning/courses/${encodeURIComponent(state.enrollment.id)}`}>
          <ArrowLeft aria-hidden /> Course overview
        </Link>
        <h1>{state.enrollment.title}</h1>
        {course.notebook && (
          <p className="outline-app-note">
            <Monitor aria-hidden />
            <span>
              Course notebook
              <br />
              <small>Complete in the app</small>
            </span>
          </p>
        )}
      </header>
      <button
        className="outline-mobile-toggle"
        aria-label="Course outline"
        aria-expanded={expanded}
        aria-controls="course-outline-navigation"
        onClick={() => setExpanded((value) => !value)}
      >
        Chapters and lessons
        <ChevronDown aria-hidden />
      </button>
      <div className="outline-content">
        <nav id="course-outline-navigation" aria-label="Course outline">
          {course.modules.map((module) => (
            <section key={module.slug} className="reader-outline-module">
              <h3>{module.title}</h3>
              <ol>
                {course.flatItems.map((item, index) => {
                  if (item.moduleId !== module.slug) return null
                  const done =
                    item.kind === 'lesson'
                      ? state.fields[`lesson:${item.lessonId}`]?.value === true
                      : Boolean(
                          (state.fields[`project:${module.slug}`]?.value as { completedAt?: string })?.completedAt
                        )
                  return (
                    <li key={item.kind === 'lesson' ? item.lessonId : module.slug}>
                      <button
                        aria-current={index === current ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(index)
                          setExpanded(false)
                        }}
                      >
                        <span
                          className={`outline-completion${done ? ' done' : ''}`}
                          role="img"
                          aria-label={done ? 'Completed' : item.kind === 'project' ? 'Project' : 'Not completed'}
                        >
                          {item.kind === 'project' && !done ? '◇' : ''}
                        </span>
                        <span>{item.kind === 'project' ? 'Project workspace' : item.title}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </nav>
      </div>
    </aside>
  )
}
