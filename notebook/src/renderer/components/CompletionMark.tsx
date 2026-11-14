import type { JSX } from 'react'

/**
 * The column before a lesson or project title in the chapter list and the
 * course contents: a filled disc in the theme's success colour once it is
 * done, otherwise empty - or the project marker, for a project. The slot keeps
 * its width either way, so every title starts at the same column.
 */
export default function CompletionMark({ done, project = false }: { done: boolean; project?: boolean }): JSX.Element {
  if (done) return <span className="check done" role="img" aria-label="Completed" />
  return <span className="check">{project ? '◇' : ''}</span>
}
