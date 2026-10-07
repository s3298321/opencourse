import { useEffect, useImperativeHandle, type Ref } from 'react'
import type { JSX } from 'react'
import { useXterm } from './useXterm'
import type { WorkbenchTheme } from './theme'

export interface TestPanelHandle {
  write: (chunk: string) => void
  clear: () => void
  /** Real width of the pane, so pytest wraps where the pane wraps. */
  cols: () => number
}

interface Props {
  theme: WorkbenchTheme
  visible: boolean
  handleRef: Ref<TestPanelHandle>
}

/**
 * Where the checks report. A read-only xterm rather than a <pre>: pytest is run
 * with colour on, and this is the only thing in the tree that understands ANSI.
 */
export default function TestPanel({ theme, visible, handleRef }: Props): JSX.Element {
  const term = useXterm(theme, {})
  const { write, clear, fit, cols } = term

  useImperativeHandle(handleRef, () => ({ write, clear, cols }), [write, clear, cols])

  useEffect(() => {
    if (visible) fit()
  }, [visible, fit])

  return <div className="term-host" ref={term.hostRef} />
}
