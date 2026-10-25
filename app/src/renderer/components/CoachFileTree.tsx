import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import type { CoachFileNode } from '@core/types'
import { TRASH_DIR, humanBytes } from '@core/coach/files'
import { Icon } from './ActionButton'

interface Props {
  projectId: string
  tree: CoachFileNode[] | null
  onChanged: () => void
  onOpen: (node: CoachFileNode) => void
}

export default function CoachFileTree({ projectId, tree, onChanged, onOpen }: Props): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const act = useCallback(
    async (run: () => Promise<{ status: string; message?: string }>) => {
      setError(null)
      try {
        const result = await run()
        if (result.status === 'ok') onChanged()
        else if (result.status === 'exists') setError('There is already something there with that name.')
        else if (result.status === 'missing') setError('That file is already gone.')
        else setError(result.message ?? 'That did not work.')
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [onChanged]
  )

  const remove = (node: CoachFileNode): void => {
    const inTrash = node.path === TRASH_DIR || node.path.startsWith(`${TRASH_DIR}/`)
    if (inTrash) {
      if (!window.confirm(`Delete “${node.name}” for good?\n\nThis cannot be undone.`)) return
      void act(() => window.opencourse.purgeCoachFile(projectId, node.path))
      return
    }
    void act(() => window.opencourse.trashCoachFile(projectId, node.path))
  }

  const row = (node: CoachFileNode, depth: number): JSX.Element => {
    const isTrash = node.path === TRASH_DIR
    const expanded = open[node.path] ?? (node.kind === 'dir' && !isTrash)
    const openable = node.kind === 'text'

    return (
      <div key={node.path}>
        <div
          className={`file-row ${node.kind}${isTrash ? ' trash' : ''}`}
          style={{ paddingLeft: `${0.6 + depth * 1.1}rem` }}
        >
          <button
            className="ghost file-name"
            title={openable ? 'Open' : node.kind === 'dir' ? 'Expand' : 'This file can only be opened outside OpenCourse'}
            onClick={() => {
              if (node.kind === 'dir') setOpen((current) => ({ ...current, [node.path]: !expanded }))
              else if (openable) onOpen(node)
            }}
          >
            <span className="file-glyph">{node.kind === 'dir' ? (expanded ? '▾' : '▸') : openable ? '·' : '◼'}</span>
            {node.name}
          </button>
          <span className="meta file-size">{node.kind === 'dir' ? '' : humanBytes(node.bytes)}</span>
          {!isTrash && (
            <button className="ghost file-act" title="Delete" aria-label={`Delete ${node.name}`} onClick={() => remove(node)}>
              <Icon name="trash" />
            </button>
          )}
        </div>

        {node.kind === 'dir' && expanded && node.children?.map((child) => row(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="coach-files panel">
      <div className="coach-brief-head">
        <h2>Workspace</h2>
      </div>

      {error && <p className="import-note error">{error}</p>}
      {tree === null && <p className="meta">Loading…</p>}
      {tree?.length === 0 && (
        <p className="meta file-empty">
          No workspace files yet.
        </p>
      )}
      {tree?.map((node) => row(node, 0))}

    </div>
  )
}
