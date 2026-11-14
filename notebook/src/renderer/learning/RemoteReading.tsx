import { useEffect, useState, type ReactNode } from 'react'
import { ServerReadingChat, type ServerReadingProps } from './ServerReadingChat'
import { desktopLearningClient } from './client'
export function RemoteReading({
  id,
  children,
  ...props
}: {
  id: string
  children: ReactNode
} & ServerReadingProps) {
  const [binding, setBinding] = useState<Awaited<ReturnType<typeof window.opencourse.learningBinding>> | undefined>(
      undefined
    ),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setBinding(undefined)
    setError('')
    const load = () =>
      void window.opencourse
        .learningBinding(id)
        .then((b) => {
          if (active) { setBinding(b); setError('') }
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
    load()
    const timer = setInterval(load, 10000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [id])
  if (error) return <p role="alert">{error}</p>
  if (binding === undefined) return <p>Loading chat…</p>
  if (binding === null) return children
  if (!binding.connected) return <p>Reconnect to the original server account in Settings to use this reading chat.</p>
  return (
    <ServerReadingChat
      {...props}
      key={binding.draftKey}
      localId={id}
      draftKey={binding.draftKey}
      client={desktopLearningClient(binding.connectionId)}
      source={binding.source}
    />
  )
}
