import { useEffect, useState } from 'react'
import type { NotebookStatus } from '@core/notebook/types'
export function useNotebookStatus(courseId: string): NotebookStatus | null {
  const [status, setStatus] = useState<NotebookStatus | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.opencourse.getNotebookStatus(courseId).then(next => {
      if (!alive) return
      setStatus(next)
      if (next.enabled && next.stage === 'idle') void window.opencourse.ensureNotebook(courseId).then(value => { if (alive) setStatus(value) }).catch(error => { if (alive) setStatus({ ...next, stage: 'failed', message: error.message }) })
    }).catch(() => {}) }
    const off = window.opencourse.onNotebookEvent(event => { if (alive && event.type === 'status' && event.courseId === courseId) setStatus(event.status) })
    const changed = window.opencourse.onCoursesChanged(refresh)
    refresh()
    return () => { alive = false; off(); changed() }
  }, [courseId])
  return status
}
