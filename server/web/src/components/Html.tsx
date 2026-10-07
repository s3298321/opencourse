import { useMemo, type ElementType } from 'react'

/**
 * Sanitized HTML, with the `__html` object memoized on the string. React 19
 * assigns innerHTML again whenever that object is new, which replaces every
 * node inside on every render - and with them any selection or focus anchored
 * there (see CLAUDE.md, "Rendering markdown"). Never write
 * dangerouslySetInnerHTML inline; use this.
 */
export function Html({ html, as: Tag = 'div', className }: { html: string; as?: ElementType; className?: string }) {
  const inner = useMemo(() => ({ __html: html }), [html])
  return <Tag className={className} dangerouslySetInnerHTML={inner} />
}
