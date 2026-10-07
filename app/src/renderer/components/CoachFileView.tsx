import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CoachFileNode } from '@core/types'
import { extensionOf, humanBytes } from '@core/coach/files'
import { useMarkdown } from '../markdown-context'

/**
 * A coach's note, read-only.
 *
 * There is no edit mode and no Save, and that is not an oversight: the renderer
 * has no channel that writes a workspace file. What the coach wrote is what the
 * coach wrote - the way to change it is to talk to it.
 */
export default function CoachFileView({
  projectId,
  node,
  onClose
}: {
  projectId: string
  node: CoachFileNode
  onClose: () => void
}): JSX.Element {
  const md = useMarkdown()
  const [state, setState] = useState<{ content: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.opencourse
      .readCoachFile(projectId, node.path)
      .then((file) => {
        if (!cancelled) setState({ content: file.content, truncated: file.truncated })
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, node.path])

  // Escape closes from anywhere in the panel, so focus it rather than an input:
  // there is nothing to type into here.
  useEffect(() => panel.current?.focus(), [])

  const isMarkdown = ['.md', '.markdown'].includes(extensionOf(node.name))
  // The object, not just the string: React 19 rewrites innerHTML whenever this
  // prop differs by reference. See components/Html.tsx.
  const html = useMemo(
    () => (state && isMarkdown ? { __html: md.render(state.content) } : null),
    [md, state, isMarkdown]
  )

  return (
    <div className="coach-overlay" onClick={onClose}>
      <div
        className="coach-panel"
        ref={panel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="coach-panel-head">
          <div>
            <h2>{node.name}</h2>
            <span className="meta">
              {node.path} · {humanBytes(node.bytes)} · read-only
            </span>
          </div>
          <button className="ghost" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="coach-panel-body scroll">
          {error && <p className="import-note error">{error}</p>}
          {!state && !error && <p className="meta">Loading…</p>}
          {state && html !== null && <div className="prose" dangerouslySetInnerHTML={html} />}
          {state && html === null && <pre className="coach-file-text">{state.content}</pre>}
        </div>
      </div>
    </div>
  )
}
