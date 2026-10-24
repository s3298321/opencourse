import { useEffect, useState } from 'react'
import { ConnectionSettings } from '../../learning-ui/ConnectionSettings'
import { desktopLearningClient } from './client'
import ActionButton from '../components/ActionButton'
export function ServerLearningSettings({ server, username }: { server: string; username: string }) {
  const [status, setStatus] = useState(''),
    [error, setError] = useState('')
  useEffect(() => {
    const refresh = () =>
      void window.opencourse
        .learningStatus()
        .then((r) =>
          setStatus(
            [
              r[server]?.state,
              r[server]?.message,
              r[server]?.lastSynced ? `Last synced ${new Date(r[server].lastSynced!).toLocaleTimeString()}` : ''
            ]
              .filter(Boolean)
              .join(' · ')
          )
        )
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [server])
  return (
    <div className="server-learning-settings">
      <div className="server-sync-row">
        <p className="server-sync-status" role="status">{status}</p>
        <ActionButton icon="refresh" className="secondary"
          onClick={() =>
            void window.opencourse
              .syncLearning(server)
              .then((r) =>
                setStatus(
                  [
                    r[server]?.state,
                    r[server]?.message,
                    r[server]?.lastSynced ? `Last synced ${new Date(r[server].lastSynced!).toLocaleTimeString()}` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')
                )
              )
              .catch((e) => setError(e.message))
          }
        >
          Sync now
        </ActionButton>
      </div>
      {error && <p className="server-sync-error" role="alert">{error}</p>}
      <details className="server-learning-details">
        <summary>Server account and AI settings</summary>
        <ConnectionSettings client={desktopLearningClient(server)} username={username} />
      </details>
    </div>
  )
}
