import { useEffect, useState } from 'react'
import type { AppUpdateInfo } from '@core/types'

/** Where an update of the app stands, kept current by main's broadcasts. Null until first read. */
export function useAppUpdate(): AppUpdateInfo | null {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  useEffect(() => {
    let alive = true
    void window.opencourse.getAppUpdate().then((next) => { if (alive) setInfo(next) })
    const off = window.opencourse.onAppUpdateChanged(setInfo)
    return () => { alive = false; off() }
  }, [])
  return info
}

/** "142 MB". */
export function formatDownloadSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}
