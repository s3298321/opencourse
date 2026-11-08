import { ToolActivityIcon } from './ToolActivityIcon'
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import type { LearningMessage } from '../core/learning/types'
import { citeAnswer, normalizeCitations, shortTitle } from '../core/sidechat/citations'

export type ReadingCitation = LearningMessage['citations'][number]

function sourceHue(host: string): number {
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

export function Thinking() {
  return <span className="chat-typing" role="status" aria-label="Thinking"><i /><i /><i /></span>
}

export function ReadingMessage({ message, renderAnswer, onSource, hideActivity }: {
  hideActivity?: boolean
  message: LearningMessage
  renderAnswer?: (text: string) => ReactNode
  onSource?: (source: ReadingCitation) => void
}) {
  const cited = useMemo(() => citeAnswer(message.text, normalizeCitations(message.citations)), [message.text, message.citations])
  // Older server messages embedded the attachment in their text.
  const legacy = message.role === 'user' && !message.quote ? /^About this passage:\n([\s\S]*)\n\n([\s\S]*?)$/.exec(message.text) : null
  const quote = message.quote ?? legacy?.[1]
  const text = legacy?.[2] ?? message.text
  const local = message.citations.filter((c, i, all) => !c.url && all.findIndex(other => other.page === c.page && other.moduleId === c.moduleId && other.lessonId === c.lessonId) === i)
  const running = message.status === 'running'
  const localLabel = local.every(c => c.page) ? 'Consulted pages' : 'Consulted sources'
  return <article className={`learning-message ${message.role}`} aria-label={message.role === 'user' ? 'You' : 'Tutor'}>
    <div className="learning-message-body">
      {message.role === 'user' ? <>{quote && <blockquote className="chat-quote">{quote}</blockquote>}{text}</>
        : message.text ? renderAnswer?.(cited.markdown) ?? cited.markdown : running ? <Thinking /> : null}
    </div>
    {message.role === 'assistant' && <>
      {!hideActivity && message.activity && running && <div className={`project-tool-activity${message.activity.running ? ' running' : ''}`} role="status">
        <ToolActivityIcon />
        <span>{message.activity.label}</span>
      </div>}
      {!!local.length && <details className="chat-sources chat-consulted-sources" data-ask="none">
        <summary className="chat-sources-label">{localLabel} ({local.length})</summary>
        <nav className="chat-local-sources" aria-label="Reading sources">{local.map((c, i) => onSource
          ? <button type="button" key={i} onClick={() => onSource(c)}>{c.title}</button>
          : <span key={i}>{c.title}</span>)}</nav>
      </details>}
      {!!cited.sources.length && <nav className="chat-sources" aria-label="Cited sources" data-ask="none">
        <div className="chat-sources-label">Cited sources</div>
        <ol>{cited.sources.map(c => <li key={c.n}><a className="chat-source" href={c.url} target="_blank" rel="noopener noreferrer" title={`${c.title}\n${c.url}`}>
          <span className="chat-source-n">{c.n}</span><span className="source-icon letter" style={{ '--hue': sourceHue(c.host) } as CSSProperties} aria-hidden="true">{c.host[0]?.toUpperCase()}</span>
          <span className="chat-source-title">{shortTitle(c.title, c.url)}</span><span className="chat-source-host">{c.host}</span>
        </a></li>)}</ol>
      </nav>}
      {message.status !== 'complete' && !running && <small>{message.status === 'cancelled' ? 'Stopped · partial response' : 'Response interrupted · partial text preserved'}</small>}
    </>}
  </article>
}
