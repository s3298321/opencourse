import { useState, type JSX } from 'react'
import type { WritingFileRead } from '@core/writing-notebooks/types'
import { codeLanguageForFile, writingTreeFileUrl } from '@core/writing-notebooks/files'
import CodeEditor from '../workbench/CodeEditor'
import { useWorkbenchTheme } from '../workbench/theme'
import { Icon } from '../components/ActionButton'

/** What the window resolved for the open file: media by name, or the result of reading it. */
export interface OpenFileView { path: string; name: string; view: { kind: 'image' } | { kind: 'video' } | WritingFileRead }

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** The card shown when a file has no viewable form: binary, too large, or undecodable media. */
function WarningCard({ name, message }: { name: string; message: string }): JSX.Element {
  return <div className="writing-file-view">
    <div className="writing-file-card" role="alert">
      <Icon name="warning" className="writing-file-card-icon" />
      <h2>{name}</h2>
      <p>{message}</p>
    </div>
  </div>
}

interface Props {
  notebookId: string
  file: OpenFileView
  textScale: number
  onChange: (text: string) => void
  onSave: () => void
}

/**
 * The main pane for a non-page file in the notebook. Images and videos render
 * inline from the asset protocol, text opens in the same CodeMirror editor the
 * exercises use (mode picked from the file extension), and anything binary
 * shows a warning card instead of garbage.
 */
export default function FileView({ notebookId, file, textScale, onChange, onSave }: Props): JSX.Element {
  const theme = useWorkbenchTheme()
  const [broken, setBroken] = useState(false)
  const { name, path } = file, view = file.view
  if (view.kind === 'image' || view.kind === 'video') {
    if (broken) return <WarningCard name={name} message="This file could not be displayed." />
    const url = writingTreeFileUrl(notebookId, path)
    return <div className="writing-file-view">
      {view.kind === 'image'
        ? <img src={url} alt={name} onError={() => setBroken(true)} />
        : <video src={url} controls onError={() => setBroken(true)} />}
    </div>
  }
  if (view.kind === 'text') {
    return <div className="writing-file-editor">
      <CodeEditor docKey={path} language={codeLanguageForFile(name)} indentUnit="  " initialDoc={view.text}
        theme={theme} textScale={textScale} ariaLabel={name} onChange={onChange} onSave={onSave} onRun={onSave} />
    </div>
  }
  return <WarningCard name={name}
    message={view.kind === 'large'
      ? `This file is ${formatBytes(view.bytes)} — too large to open as text.`
      : `This file is binary (${formatBytes(view.bytes)}), so it can't be shown as text.`} />
}
