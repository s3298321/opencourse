import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Dictation, type DictationPhase, type DictationTransport } from './dictation'
import './dictation.css'

export function useDictation(transport: DictationTransport, enabled: boolean, scope: string | null,
  limit: number, setDraft: (text: string) => void, field: RefObject<HTMLTextAreaElement | null>) {
  const session = useRef<Dictation | null>(null)
  const focusAtEnd = useRef(false)
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [speaking, setSpeaking] = useState(false)
  const [notice, setNotice] = useState('')
  const cancel = useCallback(() => {
    focusAtEnd.current = false
    const previous = session.current
    session.current = null
    previous?.close()
    setPhase('idle')
    setSpeaking(false)
    setNotice('')
  }, [])
  useLayoutEffect(() => {
    const hidden = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', cancel)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', cancel)
      cancel()
    }
  }, [enabled, scope, cancel])

  useLayoutEffect(() => {
    if (phase !== 'idle' || !focusAtEnd.current) return
    focusAtEnd.current = false
    const input = field.current
    if (input) {
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
    }
  })

  function start() {
    if (!enabled || !scope || session.current || document.hidden) return
    if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
      setNotice('Microphone access requires a supported browser on HTTPS or localhost.')
      return
    }
    setNotice('')
    const current = new Dictation(transport, limit, {
      phase: setPhase, draft: setDraft, speech: setSpeaking,
      done: status => {
        if (session.current !== current) return
        session.current = null
        focusAtEnd.current = true
        setPhase('idle')
        setSpeaking(false)
        setNotice(status)
      }
    })
    session.current = current
    void current.start()
  }
  return { phase, speaking, notice, start, stop: () => session.current?.stop(), locked: () => !!session.current }
}

export function DictationButton({ state, className }: {
  state: ReturnType<typeof useDictation>
  className: string
}) {
  const active = state.phase !== 'idle'
  const label = active ? state.phase === 'finishing' ? 'Finishing dictation' : 'Stop dictation' : 'Start dictation'
  return <button type="button" className={className} aria-label={label} title={label}
    disabled={state.phase === 'finishing'} onClick={active ? state.stop : state.start}>
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      {active ? <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none" /> :
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="7.5" y="2" width="5" height="10" rx="2.5" />
          <path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5v3M7.5 17.5h5" />
        </g>}
    </svg>
  </button>
}
