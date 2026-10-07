/**
 * One xterm instance, created on mount and disposed on unmount.
 *
 * Fit is the fiddly part: a hidden pane has no size, and FitAddon on a
 * zero-sized element proposes NaN columns and corrupts the buffer. So every
 * fit is guarded on real dimensions, and the caller re-fits when its tab
 * becomes visible.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { xtermTheme, type WorkbenchTheme } from './theme'

export interface XtermHandle {
  hostRef: (node: HTMLDivElement | null) => void
  write: (data: string) => void
  clear: () => void
  fit: () => { cols: number; rows: number } | null
  cols: () => number
}

export function useXterm(
  theme: WorkbenchTheme,
  options: { onData?: (data: string) => void; onResize?: (cols: number, rows: number) => void }
): XtermHandle {
  const term = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const node = useRef<HTMLDivElement | null>(null)
  const callbacks = useRef(options)
  callbacks.current = options
  // Read at creation; a later theme is applied to the live terminal below.
  const themeRef = useRef(theme)
  themeRef.current = theme
  const applied = useRef<WorkbenchTheme | null>(null)

  const fit = useCallback((): { cols: number; rows: number } | null => {
    const host = node.current
    if (!host || !term.current || !fitAddon.current) return null
    if (host.clientWidth === 0 || host.clientHeight === 0) return null
    const proposed = fitAddon.current.proposeDimensions()
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null
    if (proposed.cols < 2 || proposed.rows < 1) return null
    if (proposed.cols !== term.current.cols || proposed.rows !== term.current.rows) {
      term.current.resize(proposed.cols, proposed.rows)
    }
    return { cols: term.current.cols, rows: term.current.rows }
  }, [])

  const hostRef = useCallback((next: HTMLDivElement | null) => {
    node.current = next
  }, [])

  useEffect(() => {
    const host = node.current
    if (!host) return undefined

    const initial = (applied.current = themeRef.current)
    const terminal = new Terminal({
      fontFamily: initial.mono,
      fontSize: 12 * initial.codeScale,
      lineHeight: 1.2,
      cursorBlink: Boolean(options.onData),
      convertEol: false,
      scrollback: 5000,
      theme: xtermTheme(initial),
      allowProposedApi: true
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(host)
    term.current = terminal
    fitAddon.current = addon

    const dataSub = terminal.onData((data) => callbacks.current.onData?.(data))

    let frame = 0
    let debounce: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        frame = window.requestAnimationFrame(() => {
          const size = fit()
          if (size) callbacks.current.onResize?.(size.cols, size.rows)
        })
      }, 50)
    })
    observer.observe(host)

    const size = fit()
    if (size) callbacks.current.onResize?.(size.cols, size.rows)

    return () => {
      observer.disconnect()
      window.clearTimeout(debounce)
      window.cancelAnimationFrame(frame)
      dataSub.dispose()
      terminal.dispose()
      term.current = null
      fitAddon.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A theme changes the live terminal's options rather than replacing it, which
  // would lose the scrollback. A new font changes the cell size, so refit.
  useEffect(() => {
    const terminal = term.current
    if (!terminal || applied.current === theme) return
    applied.current = theme
    terminal.options.theme = xtermTheme(theme)
    terminal.options.fontFamily = theme.mono
    terminal.options.fontSize = 12 * theme.codeScale
    const size = fit()
    if (size) callbacks.current.onResize?.(size.cols, size.rows)
  }, [theme, fit])

  const write = useCallback((data: string) => term.current?.write(data), [])
  const clear = useCallback(() => term.current?.clear(), [])
  const cols = useCallback(() => term.current?.cols ?? 80, [])

  return { hostRef, write, clear, fit, cols }
}
