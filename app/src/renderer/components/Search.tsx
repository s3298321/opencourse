import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { MIN_QUERY, searchCourse } from '@core/search'
import type { CourseView } from '@core/types'
import type { Route } from '../routes'

interface Props {
  course: CourseView
  navigate: (r: Route) => void
  onClose: () => void
}

export default function Search({ course, navigate, onClose }: Props): JSX.Element {
  const [term, setTerm] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const hits = useMemo(() => searchCourse(course, term), [course, term])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          value={term}
          placeholder={`Search ${course.title}`}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && hits[0]) {
              navigate(hits[0].kind === 'project' ? { name: 'project', courseId: course.courseId, moduleId: hits[0].moduleId } : { name: 'lesson', courseId: course.courseId, moduleId: hits[0].moduleId, lessonId: hits[0].lessonId! })
              onClose()
            }
          }}
        />
        <div className="search-hits">
          {term.trim().length >= MIN_QUERY && hits.length === 0 && <div className="meta">No matches.</div>}
          {hits.map((hit) => (
            <div
              key={`${hit.moduleId}/${hit.lessonId}`}
              className="search-hit"
              onClick={() => {
                navigate(hit.kind === 'project' ? { name: 'project', courseId: course.courseId, moduleId: hit.moduleId } : { name: 'lesson', courseId: course.courseId, moduleId: hit.moduleId, lessonId: hit.lessonId! })
                onClose()
              }}
            >
              <div>{hit.lessonTitle}</div>
              <div className="meta">{hit.excerpt ?? hit.moduleTitle}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
