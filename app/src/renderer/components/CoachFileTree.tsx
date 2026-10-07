import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CoachFileNode } from '@core/types'
import { TRASH_DIR, folderPaths, humanBytes } from '@core/coach/files'

interface Props {
  projectId: string
  tree: CoachFileNode[] | null
  onChanged: () => void
  onOpen: (node: CoachFileNode) => void
}

/** Where a file can be moved to, named the way a person would say it. */
function folderLabel(path: string): string {
  return path === '' ? 'the top level' : path
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export default function CoachFileTree({ projectId, tree, onChanged, onOpen }: Props): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [moving, setMoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A tree that changed underneath us must not keep a stale row selected.
  useEffect(() => setMoving(null), [tree])

  const folders = tree ? folderPaths(tree) : ['']

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

  const move = (node: CoachFileNode, to: string): void => {
    setMoving(null)
    if (to === parentOf(node.path)) return
    void act(() => window.opencourse.moveCoachFile(projectId, node.path, to ? `${to}/${node.name}` : node.name))
  }

  const addFolder = (): void => {
    const name = window.prompt('Name the folder.\n\nLetters, digits, dot, dash and underscore only.')
    if (!name) return
    void act(() => window.opencourse.createCoachFolder(projectId, '', name))
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
            <>
              <button className="ghost file-act" title="Move" onClick={() => setMoving(moving === node.path ? null : node.path)}>
                ↔
              </button>
              <button className="ghost file-act" title="Delete" onClick={() => remove(node)}>
                ✕
              </button>
            </>
          )}
        </div>

        {moving === node.path && (
          <div className="file-move" style={{ paddingLeft: `${1.7 + depth * 1.1}rem` }}>
            <span className="meta">Move to</span>
            <select
              defaultValue={parentOf(node.path)}
              onChange={(e) => move(node, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMoving(null)
              }}
            >
              {folders
                .filter((folder) => folder !== node.path && !folder.startsWith(`${node.path}/`))
                .map((folder) => (
                  <option key={folder || '/'} value={folder}>
                    {folderLabel(folder)}
                  </option>
                ))}
            </select>
          </div>
        )}

        {node.kind === 'dir' && expanded && node.children?.map((child) => row(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="coach-files panel">
      <div className="coach-brief-head">
        <h2>Workspace</h2>
        <button className="ghost" onClick={addFolder}>
          New folder
        </button>
      </div>

      {error && <p className="import-note error">{error}</p>}
      {tree === null && <p className="meta">Loading…</p>}
      {tree?.length === 0 && (
        <p className="meta file-empty">
          Nothing here yet. The coach writes its own notes during a session — you can read them, move them and
          delete them, but the coach is the one who writes them.
        </p>
      )}
      {tree?.map((node) => row(node, 0))}

      {tree !== null && tree.length > 0 && (
        <p className="meta file-foot">
          Text files open here. Everything else can be moved or deleted, and opened in Finder.
        </p>
      )}
    </div>
  )
}
