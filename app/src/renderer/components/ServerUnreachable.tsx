import ActionButton from './ActionButton'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ServerConnection } from '@core/types'

/** A server the app's requests could not reach (main/server-health.ts). */
export const serverDown = (server: ServerConnection | null | undefined): boolean => server?.status === 'unreachable'

/** Why a control that needs the server is off. */
export const downTitle = (server: ServerConnection): string => `${server.name} is not answering. This comes back by itself when it does.`

/**
 * One connection, kept current as servers change; `onBack` runs when it
 * answers again after not answering, so a page can load what it could not.
 */
export function useServerConnection(serverId: string, onBack?: () => void): ServerConnection | null {
  const [server, setServer] = useState<ServerConnection | null>(null)
  const back = useRef(onBack)
  back.current = onBack
  const wasDown = useRef(false)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.opencourse.listServers().then((list) => {
        if (!alive) return
        const next = list.find((s) => s.id === serverId) ?? null
        if (wasDown.current && next && !serverDown(next)) back.current?.()
        wasDown.current = serverDown(next)
        setServer(next)
      }).catch(() => {})
    }
    load()
    const off = window.opencourse.onServersChanged(load)
    return () => { alive = false; off() }
  }, [serverId])
  return server
}

/**
 * What every screen that needs a server shows while it is not answering:
 * which server, that what is already here still works, and a way to look
 * again now. Main keeps looking on its own and the screen follows when it
 * answers, so Retry is a shortcut, not the only way back.
 */
export default function ServerUnreachable({ server }: { server: ServerConnection }): JSX.Element {
  const [checking, setChecking] = useState(false)
  const retry = async (): Promise<void> => {
    setChecking(true)
    try { await window.opencourse.retryServer(server.id) } catch { /* still down: the notice stays */ } finally { setChecking(false) }
  }
  return (
    <div className="server-unreachable" role="status" data-server={server.id}>
      <p><strong>Can’t reach {server.name}.</strong> What you have already added still works offline; anything that needs the server waits until it answers again.</p>
      <ActionButton icon="refresh" className="secondary" disabled={checking} onClick={() => void retry()}>{checking ? 'Checking' : 'Retry'}</ActionButton>
    </div>
  )
}
