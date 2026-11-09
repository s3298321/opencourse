import { useEffect, useState } from 'react'
import type { DictationTransport } from '../../learning-ui/dictation'

export interface ServerDictation { localId: string; available: boolean }

export function useDesktopDictation(visible: boolean, server?: ServerDictation) {
  const [available, setAvailable] = useState(false)
  const api = window.opencourse?.dictation
  const local = !server && visible
  useEffect(() => {
    if (!local || !api) return
    let revision = 0
    const refresh = () => {
      const request = ++revision
      void api.settings().then(({ configured }) => {
        if (request === revision) setAvailable(configured)
      }).catch(() => { if (request === revision) setAvailable(false) })
    }
    refresh()
    const unsubscribe = window.opencourse.onAIChanged(refresh)
    return () => { revision++; unsubscribe() }
  }, [local, api])
  const transport: DictationTransport = {
    begin: id => api.begin(id, server?.localId),
    connect: (id, sdp) => api.connect(id, sdp),
    end: id => api.end(id),
    onEnded: handler => api.onEnded(handler)
  }
  return { transport, available: !!api && (server ? server.available : available) }
}
