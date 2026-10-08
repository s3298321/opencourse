import type { JSX } from 'react'
import { lessonKey } from '@core/manifest'
import type { CourseProgress, CourseView } from '@core/types'
import type { Route } from '../routes'
import CompletionMark from './CompletionMark'

interface Props {
  course: CourseView
  current: { moduleId: string; lessonId?: string }
  progress: CourseProgress
  navigate: (r: Route) => void
}

export default function Sidebar({ course, current, progress, navigate }: Props): JSX.Element {
  const done = new Set(progress.completedLessons)

  return (
    <nav className="sidebar scroll">
      <div className="course-title">
        <a onClick={() => navigate({ name: 'course', courseId: course.courseId })}>{course.title}</a>
      </div>
      {course.modules.map((mod) => (
        <div key={mod.slug}>
          <div className="module-title">{mod.title}</div>
          <ol>
            {mod.type === 'project' ? (
              <li><a className={current?.moduleId === mod.slug ? 'current' : undefined} onClick={() => navigate({ name: 'project', courseId: course.courseId, moduleId: mod.slug })}>
                <CompletionMark done={!!progress.projects?.[mod.slug]?.completedAt} project /><span>Project workspace</span>
              </a></li>
            ) : mod.lessons.map((lesson) => {
              const isCurrent = current.moduleId === mod.slug && current.lessonId === lesson.slug
              return (
                <li key={lesson.slug}>
                  <a
                    className={isCurrent ? 'current' : undefined}
                    onClick={() =>
                      navigate({
                        name: 'lesson',
                        courseId: course.courseId,
                        moduleId: mod.slug,
                        lessonId: lesson.slug
                      })
                    }
                  >
                    <CompletionMark done={done.has(lessonKey(mod.slug, lesson.slug))} />
                    <span>{lesson.title}</span>
                  </a>
                </li>
              )
            })}
          </ol>
        </div>
      ))}
    </nav>
  )
}
