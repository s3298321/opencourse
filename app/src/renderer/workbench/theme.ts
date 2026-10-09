/**
 * CodeMirror and xterm both need real colour values, not CSS variables, so we
 * read the tokens from the stylesheet - and read them again whenever a theme is
 * applied. The editor and terminal take the new values in place (a CodeMirror
 * compartment, xterm's options): neither a theme nor the system appearance ever
 * recreates one, because that costs undo history and scrollback.
 */
import { useEffect, useState } from 'react'
import { onThemeApplied } from '../theme/events'

export interface WorkbenchTheme {
  dark: boolean
  fg: string
  bg: string
  muted: string
  accent: string
  border: string
  ok: string
  err: string
  scrollbar: string
  scrollbarHover: string
  activeLine: string
  selection: string
  /** The code font stack, from --font-mono. */
  mono: string
}

/**
 * The editor's and the terminal's type size. Not a token: a theme does not set
 * how large text is, and the reader's text size is for reading, not for code.
 */
export const EDITOR_FONT_PX = 12.5
export const TERMINAL_FONT_PX = 12

/** The editor and terminal must use a stack that is always present offline. */
export const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace'

export function readWorkbenchTheme(): WorkbenchTheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    dark: document.documentElement.dataset['appearance'] !== 'light',
    fg: token('--fg', '#dedee3'),
    bg: token('--code-bg', '#1d1d21'),
    muted: token('--muted', '#a5a5af'),
    accent: token('--accent', '#c4c4cd'),
    border: token('--border', '#393940'),
    ok: token('--ok', '#78bd91'),
    err: token('--err', '#ee9292'),
    scrollbar: token('--scrollbar', 'rgba(222, 222, 227, 0.18)'),
    scrollbarHover: token('--scrollbar-hover', 'rgba(222, 222, 227, 0.36)'),
    activeLine: token('--editor-active-line', 'rgba(255, 255, 255, 0.04)'),
    selection: token('--terminal-selection', 'rgba(196, 196, 205, 0.18)'),
    mono: token('--font-mono', MONO_STACK)
  }
}

export function useWorkbenchTheme(): WorkbenchTheme {
  const [theme, setTheme] = useState<WorkbenchTheme>(readWorkbenchTheme)
  useEffect(() => onThemeApplied(() => setTheme(readWorkbenchTheme())), [])
  return theme
}

/** xterm wants an explicit palette; give it the app's, not its own default. */
export function xtermTheme(theme: WorkbenchTheme): Record<string, string> {
  return {
    background: theme.bg,
    foreground: theme.fg,
    cursor: theme.accent,
    cursorAccent: theme.bg,
    selectionBackground: theme.selection,
    // The same three states as every other scrollbar in the window.
    scrollbarSliderBackground: theme.scrollbar,
    scrollbarSliderHoverBackground: theme.scrollbarHover,
    scrollbarSliderActiveBackground: theme.accent
  }
}

/**
 * Syntax colours matching the GitHub themes Shiki already uses for the code
 * blocks in the lesson prose, so an exercise does not look like a different
 * app from the paragraph above it.
 */
export function highlightColors(dark: boolean): {
  keyword: string
  string: string
  comment: string
  fn: string
  number: string
  type: string
  variable: string
} {
  return dark
    ? {
        keyword: '#ff7b72',
        string: '#a5d6ff',
        comment: '#8b949e',
        fn: '#d2a8ff',
        number: '#79c0ff',
        type: '#ffa657',
        variable: '#e6edf3'
      }
    : {
        keyword: '#cf222e',
        string: '#0a3069',
        comment: '#6e7781',
        fn: '#8250df',
        number: '#0550ae',
        type: '#953800',
        variable: '#24292f'
      }
}
