import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { useXterm } from './useXterm'
import type { WorkbenchTheme } from './theme'

interface Props {
  sessionId: string
  cwd: string
  envDir?: string
  language: string
  theme: WorkbenchTheme
  /** The pane is kept mounted while hidden, so re-fit when it comes back. */
  visible: boolean
  onExit: (exitCode: number) => void
}

/**
 * An interactive shell in the exercise directory with the course venv active.
 * The pty belongs to this mount: navigating away disposes it rather than
 * leaving a shell writing into a frame that no longer exists.
 */
export default function TerminalView({ sessionId, cwd, envDir, language, theme, visible, onExit }: Props): JSX.Element {
  const size = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
  const ready = useRef(false)

  const term = useXterm(theme, {
    onData: (data) => {
      if (ready.current) void window.opencourse.writePty(sessionId, data)
    },
    onResize: (cols, rows) => {
      size.current = { cols, rows }
      if (ready.current) void window.opencourse.resizePty(sessionId, cols, rows)
    }
  })

  const { write, fit } = term

  useEffect(() => {
    let disposed = false
    const offData = window.opencourse.onPtyData((id, chunk) => {
      if (id === sessionId) write(chunk)
    })
    const offExit = window.opencourse.onPtyExit((id, exitCode) => {
      if (id !== sessionId) return
      ready.current = false
      write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`)
      onExit(exitCode)
    })

    void window.opencourse
      .createPty(sessionId, { cwd, envDir, language, cols: size.current.cols, rows: size.current.rows })
      .then((result) => {
        if (disposed) return
        if (result.ok) ready.current = true
        else write(`\r\n\x1b[31mCould not start a shell: ${result.error ?? 'unknown error'}\x1b[0m\r\n`)
      })

    return () => {
      disposed = true
      ready.current = false
      offData()
      offExit()
      void window.opencourse.killPty(sessionId)
    }
    // onExit is read fresh on every event, so it is deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd, envDir, language, write])

  useEffect(() => {
    if (!visible) return
    const size = fit()
    if (size) void window.opencourse.resizePty(sessionId, size.cols, size.rows)
  }, [visible, fit, sessionId])

  return <div className="term-host" ref={term.hostRef} />
}
