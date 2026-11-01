import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoachProject } from '@core/types'
import { LiveSession, type SessionView } from './live'

export type SelectedCoach = Pick<CoachProject, 'id' | 'name'>
interface Operation { cancelled: boolean; live: LiveSession | null; start: Promise<void> | null; stop?: Promise<void> }

/** Owned by the shell's launcher, never by the visible conversation panel. */
export function useCoachConversation() {
  const operation = useRef<Operation | null>(null), mounted = useRef(true)
  const [coach, setCoach] = useState<SelectedCoach | null>(null), [view, setView] = useState<SessionView | null>(null)
  const [starting, setStarting] = useState(false), [stopping, setStopping] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const complete = useCallback((op: Operation, failure?: string) => {
    if (!mounted.current || operation.current !== op) return
    // Tool failures are returned to the coach to handle during the conversation.
    // Only session-level warnings belong in the notice after it ends.
    const failures = op.live?.view().activity.filter(entry => !entry.ok && entry.state === undefined).map(entry => entry.text) ?? []
    setNotice(failure || (failures.length ? failures.join(' ') : 'Conversation ended.'))
    operation.current = null
    setCoach(null); setView(null); setStarting(false); setStopping(false)
  }, [])
  useEffect(() => {
    mounted.current = true
    const abandon = () => { const op = operation.current; if (op) { op.cancelled = true; op.live?.abandon() } }
    const timer = setInterval(() => {
      const op = operation.current
      if (!op?.live) return
      const next = op.live.view()
      if (next.status.kind === 'ended' && !op.stop) complete(op)
      else setView(next)
    }, 150)
    window.addEventListener('beforeunload', abandon)
    return () => { mounted.current = false; abandon(); clearInterval(timer); window.removeEventListener('beforeunload', abandon) }
  }, [complete])

  const start = useCallback(async (selected: SelectedCoach) => {
    if (operation.current) return
    const op: Operation = { cancelled: false, live: null, start: null }
    operation.current = op
    setCoach(selected); setView(null); setError(''); setNotice(''); setStarting(true); setStopping(false)
    op.start = (async () => {
      try {
        const result = await window.opencourse.startCoachSession(selected.id)
        if (result.status !== 'ok') throw new Error(result.status === 'no-key' ? 'Add an OpenAI API key in Settings to talk to your coach.' : result.status === 'mic-denied' ? 'Allow microphone access for OpenCourse, then try again.' : result.message)
        if (op.cancelled || !mounted.current) {
          await window.opencourse.endCoachSession(result.sessionId, { status: 'ended' })
          return
        }
        const live = new LiveSession(result, () => {})
        op.live = live
        await live.start()
        if (mounted.current && operation.current === op) setView(live.view())
      } catch (cause) {
        if (mounted.current && operation.current === op && !op.cancelled) {
          setError((cause as Error).message)
          op.live?.abandon()
          operation.current = null
        }
      } finally {
        if (mounted.current && (operation.current === op || !operation.current)) setStarting(false)
      }
    })()
    await op.start
  }, [])

  const stop = useCallback(async () => {
    const op = operation.current
    if (!op) { setCoach(null); setError(''); return }
    if (op.stop) return op.stop
    op.cancelled = true
    setStopping(true)
    op.stop = (async () => {
      let failure: string | undefined
      try {
        if (op.live) await op.live.stop()
        else await op.start
      } catch (cause) {
        op.live?.abandon()
        failure = (cause as Error).message
      } finally { complete(op, failure) }
    })()
    await op.stop
  }, [complete])
  return { coach, view, starting, stopping, error, notice, start, stop, busy: starting || stopping || !!operation.current }
}
