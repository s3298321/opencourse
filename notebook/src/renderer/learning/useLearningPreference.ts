import { useCallback, useEffect, useState } from 'react'

/** A remote reading preference has its own durable outbox; local readers keep their existing settings. */
export function useLearningPreference(id: string, name: 'readingScale' | 'pdfZoom') {
  const [preference, setPreference] = useState<{ value?: number } | null>(null)
  useEffect(() => {
    let active = true
    setPreference(null)
    const refresh = () => {
      if (!window.opencourse.learningPreference) return
      void window.opencourse
        .learningPreference(id, name)
        .then((value) => {
          if (active) setPreference(value)
        })
        .catch(() => {})
    }
    refresh()
    const unsubscribe = window.opencourse.onCoursesChanged?.(refresh)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [id, name])
  const set = useCallback(
    (value: number) => {
      setPreference({ value })
      void window.opencourse.learningPreference(id, name, value).catch(() => {})
    },
    [id, name]
  )
  return { value: preference?.value, bound: preference !== null, set }
}
