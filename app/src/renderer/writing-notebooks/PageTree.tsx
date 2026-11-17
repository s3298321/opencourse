import { useRef, useState, type DragEvent, type JSX } from 'react'
import type { WritingNotebook, WritingTreeNode } from '@core/writing-notebooks/types'
import { pagesUnder, treeParent } from '@core/writing-notebooks/tree'
import Menu from '../components/Menu'
import { Icon, type ActionIcon } from '../components/ActionButton'

/** Everything the tree can ask the window to do; the window owns flushing and confirms. */
export interface PageTreeActions {
  openPage: (pageId: string) => void
  selectFolder: (path: string) => void
  newPage: (folder: string) => void
  newFolder: (parent: string) => void
  deletePage: (pageId: string, title: string) => void
  deleteFolder: (path: string, name: string, pageCount: number) => void
  deleteFile: (path: string, name: string) => void
  reveal: (path: string) => void
  move: (source: string, targetFolder: string) => void
  dropPage: (pageId: string, targetFolder: string, anchor: { pageId: string; after: boolean } | null) => void
}

type Dragged = { path: string; kind: 'folder' | 'page' | 'file'; pageId?: string }
type DropHint = { kind: 'folder'; path: string } | { kind: 'page'; id: string }

/** A foreign file's icon, guessed from its extension; unknown types get a plain sheet. */
function fileIcon(name: string): ActionIcon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif', 'tif', 'tiff'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff'].includes(ext)) return 'audio'
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return 'archive'
  if (['csv', 'tsv', 'xls', 'xlsx', 'numbers'].includes(ext)) return 'table'
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'swift', 'sh', 'bash', 'zsh', 'json', 'yaml', 'yml', 'toml', 'ini', 'html', 'htm', 'css', 'scss', 'sql', 'xml', 'ipynb'].includes(ext)) return 'fileCode'
  if (['md', 'markdown', 'txt', 'text', 'rst', 'log', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'pages'].includes(ext)) return 'fileText'
  return 'file'
}

/**
 * The notebook's left pane: real folders on disk, pages in manual order, and
 * any other file visible but not openable. Folders select (the create buttons
 * below the tree follow the selection), wrap and unwrap, and accept drops;
 * clicking the empty pane below the rows clears the selection back to the
 * root. Pages also reorder by dropping above or below a sibling.
 */
export default function PageTree({ notebook, currentPageId, selectedFolder, busy, draftFolder, onDraftCommit, onDraftCancel, actions }: {
  notebook: WritingNotebook
  currentPageId: string
  selectedFolder: string
  busy: boolean
  draftFolder: { parent: string } | null
  onDraftCommit: (name: string) => void
  onDraftCancel: () => void
  actions: PageTreeActions
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // The dragged entry lives in a ref: dragover can arrive before a re-render,
  // and a stale closure would silently refuse every drop.
  const draggingRef = useRef<Dragged | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const tree = notebook.tree ?? []
  const toggle = (path: string) => setCollapsed(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const startDrag = (event: DragEvent, entry: Dragged) => {
    event.dataTransfer.setData('text/x-writing-entry', entry.path)
    event.dataTransfer.effectAllowed = 'move'
    draggingRef.current = entry
  }
  const endDrag = () => { draggingRef.current = null; setDropHint(null) }
  // A folder never drops into itself or its own subtree.
  const canDrop = (folder: string) => { const dragging = draggingRef.current; return Boolean(dragging) && !(dragging!.kind === 'folder' && (folder === dragging!.path || folder.startsWith(dragging!.path + '/'))) }
  const overFolder = (event: DragEvent, folder: string) => {
    if (!draggingRef.current) return
    if (!canDrop(folder)) { event.stopPropagation(); return }
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropHint({ kind: 'folder', path: folder })
  }
  const dropOnFolder = (event: DragEvent, folder: string) => {
    if (!draggingRef.current) return
    if (!canDrop(folder)) { event.stopPropagation(); return }
    event.preventDefault(); event.stopPropagation()
    const source = draggingRef.current.path
    endDrag()
    actions.move(source, folder)
  }
  const overPage = (event: DragEvent, node: WritingTreeNode & { kind: 'page' }) => {
    const dragging = draggingRef.current
    if (!dragging) return
    if (dragging.kind === 'folder' && !canDrop(treeParent(node.path))) { event.stopPropagation(); return }
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropHint({ kind: 'page', id: node.id })
  }
  const dropOnPage = (event: DragEvent, node: WritingTreeNode & { kind: 'page' }) => {
    const dragging = draggingRef.current
    if (!dragging) return
    const folder = treeParent(node.path)
    if (dragging.kind === 'folder' && !canDrop(folder)) { event.stopPropagation(); return }
    event.preventDefault(); event.stopPropagation()
    endDrag()
    if (dragging.kind === 'page') {
      if (dragging.pageId === node.id) return
      const rect = event.currentTarget.getBoundingClientRect()
      actions.dropPage(dragging.pageId!, folder, { pageId: node.id, after: event.clientY > rect.top + rect.height / 2 })
    } else actions.move(dragging.path, folder)
  }
  const draft = (depth: number) => <FolderDraft key={`${draftFolder!.parent}:${depth}`} depth={depth} onCommit={onDraftCommit} onCancel={onDraftCancel} />
  const renderNodes = (nodes: WritingTreeNode[], depth: number): JSX.Element[] => nodes.map(node => {
    if (node.kind === 'folder') {
      const open = !collapsed.has(node.path) || draftFolder?.parent === node.path
      const hint = dropHint?.kind === 'folder' && dropHint.path === node.path && canDrop(node.path)
      return <div key={node.path} className="writing-tree-branch">
        <div className={`writing-tree-row folder${selectedFolder === node.path ? ' selected' : ''}${hint ? ' drop-target' : ''}`} style={{ paddingLeft: depth * 12 }}
          draggable onDragStart={event => startDrag(event, { path: node.path, kind: 'folder' })} onDragEnd={endDrag}
          onDragOver={event => overFolder(event, node.path)} onDrop={event => dropOnFolder(event, node.path)}>
          <button type="button" className="writing-tree-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(node.path)}><Icon name={open ? 'folderOpen' : 'folder'} /></button>
          <Menu triggerMode="contextmenu" className="writing-tree-label" disabled={busy} label={<span>{node.name}</span>}
            onClick={() => { actions.selectFolder(node.path); toggle(node.path) }}
            draggable onDragStart={event => startDrag(event, { path: node.path, kind: 'folder' })}
            items={[
              { id: 'new-page', label: 'New page here', onSelect: () => actions.newPage(node.path) },
              { id: 'new-folder', label: 'New folder here', onSelect: () => actions.newFolder(node.path) },
              { id: 'reveal', label: 'Reveal in Finder', onSelect: () => actions.reveal(node.path) },
              { id: 'delete', label: 'Delete folder', danger: true, onSelect: () => actions.deleteFolder(node.path, node.name, pagesUnder(tree, node.path).length) }
            ]} />
        </div>
        {open && renderNodes(node.children, depth + 1)}
        {open && draftFolder?.parent === node.path && draft(depth + 1)}
      </div>
    }
    if (node.kind === 'page') {
      const hint = dropHint?.kind === 'page' && dropHint.id === node.id
      return <div key={node.id} className={`writing-tree-row page${node.id === currentPageId ? ' current' : ''}${hint ? ' drop-target' : ''}`} style={{ paddingLeft: depth * 12 }}
        onDragOver={event => overPage(event, node)} onDrop={event => dropOnPage(event, node)}>
        <Menu triggerMode="contextmenu" disabled={busy} resetKey={currentPageId}
          className={`sidebar-notebook-link writing-page-link${node.id === currentPageId ? ' current' : ''}`}
          aria-current={node.id === currentPageId ? 'page' : undefined}
          label={<><Icon name="page" className="writing-tree-icon" /><span>{node.title}</span></>} onClick={() => actions.openPage(node.id)}
          draggable onDragStart={event => startDrag(event, { path: node.path, kind: 'page', pageId: node.id })} onDragEnd={endDrag}
          items={[
            { id: 'delete', label: 'Delete page', danger: true, disabled: notebook.pages.length === 1, hint: notebook.pages.length === 1 ? 'Keep at least one page' : undefined, onSelect: () => actions.deletePage(node.id, node.title) },
            { id: 'reveal', label: 'Reveal in Finder', onSelect: () => actions.reveal(node.path) }
          ]} />
      </div>
    }
    return <div key={node.path} className="writing-tree-row file" style={{ paddingLeft: depth * 12 }}
      draggable onDragStart={event => startDrag(event, { path: node.path, kind: 'file' })} onDragEnd={endDrag}>
      <Menu triggerMode="contextmenu" className="writing-tree-label writing-file-label" disabled={busy} label={<><Icon name={fileIcon(node.name)} className="writing-tree-icon" /><span>{node.name}</span></>}
        onClick={() => { /* Foreign files are shown, moved and deleted — never opened. */ }}
        items={[
          { id: 'delete', label: 'Delete file', danger: true, onSelect: () => actions.deleteFile(node.path, node.name) },
          { id: 'reveal', label: 'Reveal in Finder', onSelect: () => actions.reveal(node.path) }
        ]} />
    </div>
  })
  return <nav aria-label="Notebook pages" className={`writing-tree${dropHint?.kind === 'folder' && dropHint.path === '' && canDrop('') ? ' drop-root' : ''}`}
    onClick={event => { if (event.target === event.currentTarget) actions.selectFolder('') }}
    onDragOver={event => overFolder(event, '')} onDrop={event => dropOnFolder(event, '')}>
    {renderNodes(tree, 0)}
    {draftFolder?.parent === '' && draft(0)}
  </nav>
}

/** The inline name input for a new folder: Enter creates, Escape or blur cancels. */
function FolderDraft({ depth, onCommit, onCancel }: { depth: number; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('')
  const submitted = useRef(false)
  const commit = () => {
    if (submitted.current) return
    submitted.current = true
    if (value.trim()) onCommit(value); else onCancel()
  }
  return <div className="writing-tree-row draft" style={{ paddingLeft: depth * 12 }}>
    <input autoFocus type="text" aria-label="New folder name" placeholder="Folder name" maxLength={200}
      value={value} onChange={event => setValue(event.target.value)}
      onBlur={() => { if (!submitted.current) onCancel() }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit() }
        if (event.key === 'Escape') { event.preventDefault(); submitted.current = true; onCancel() }
      }} />
  </div>
}