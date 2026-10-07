import { Link, useViewTransitionState } from 'react-router'
import { Download } from 'lucide-react'
import type { CatalogCourse } from '@core/catalog/api'
import { capitalize, compact, hours, plural } from '../lib/format'
import { plainText } from '../lib/markdown'
import { Cover } from './Cover'

export function CourseCard({ course }: { course: CatalogCourse }) {
  const to = `/courses/${encodeURIComponent(course.id)}`
  // Only the card being opened carries the shared name, so the page knows which cover to fly.
  const opening = useViewTransitionState(to)
  const meta = [course.subject, course.difficulty && capitalize(course.difficulty), plural(course.lessonCount, 'lesson'), hours(course)].filter(Boolean)
  return (
    <li className="course-card oc-card oc-glow" data-glow>
      <Link to={to} className="course-card-link" viewTransition>
        <Cover id={course.id} title={course.title} subject={course.subject} hasCover={course.hasCover} transitionName={opening ? 'course-cover' : undefined} />
        <div className="course-card-body">
          <h3 style={opening ? { viewTransitionName: 'course-title' } : undefined}>{course.title}</h3>
          <p className="course-card-meta">{meta.join(' · ')}</p>
          {course.description && <p className="course-card-summary">{plainText(course.description)}</p>}
          <div className="course-card-foot">
            <span className="oc-pill">v{course.version}</span>
            <span className="course-card-stat" title={plural(course.downloads, 'learner')}><Download aria-hidden />{compact(course.downloads)}</span>
            <span className="course-card-publisher">by {course.publisher}</span>
          </div>
        </div>
      </Link>
    </li>
  )
}

export function CourseCardSkeleton() {
  return (
    <li className="course-card oc-card skeleton-card" aria-hidden="true">
      <div className="cover oc-skeleton" />
      <div className="course-card-body">
        <div className="oc-skeleton line w70" />
        <div className="oc-skeleton line w40" />
        <div className="oc-skeleton line w90" />
        <div className="oc-skeleton line w60" />
      </div>
    </li>
  )
}
