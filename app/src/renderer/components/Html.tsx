import { useMemo } from 'react'
import type { JSX } from 'react'
import { useMarkdown } from '../markdown-context'

/**
 * Rendered markdown, with the `{ __html }` object held stable across renders.
 *
 * That stability is the whole point. React 19's `setProp` writes
 * `domElement.innerHTML` *unconditionally* whenever it processes a
 * `dangerouslySetInnerHTML` prop - the React 18 "same string, skip it" check is
 * gone - and it processes the prop whenever the value differs by reference. A
 * fresh `{ __html: … }` literal every render therefore replaces every child
 * node of the block on every render, even when the markup is identical.
 *
 * Nobody notices until something is anchored to those nodes. Highlighting a
 * passage in a lesson sets state; the state re-renders the lesson; the re-render
 * swaps the paragraph the highlight lived in for an identical one, and the
 * selection - and the "Ask about this" offer with it - vanished before it could
 * be clicked.
 */
export default function Html({
  source,
  inline = false,
  as: Tag = 'div',
  className
}: {
  source: string
  /** Inline markdown: no wrapping <p>, for text that sits inside a sentence. */
  inline?: boolean
  as?: 'div' | 'span' | 'li' | 'p'
  className?: string
}): JSX.Element {
  const md = useMarkdown()
  const html = useMemo(
    () => ({ __html: inline ? md.renderInline(source) : md.render(source) }),
    [md, source, inline]
  )
  return <Tag {...(className ? { className } : {})} dangerouslySetInnerHTML={html} />
}
