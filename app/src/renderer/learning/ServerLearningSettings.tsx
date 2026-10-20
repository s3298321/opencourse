import { useEffect, useState } from 'react'
import { ConnectionSettings } from '../../learning-ui/ConnectionSettings'
import { desktopLearningClient } from './client'
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
    <div>
      <p role="status">{status}</p>
      <button
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
      </button>
      {error && <p role="alert">{error}</p>}
      <details className="server-learning-details">
        <summary>Server account and AI settings</summary>
        <ConnectionSettings client={desktopLearningClient(server)} username={username} />
      </details>
    </div>
  )
}
