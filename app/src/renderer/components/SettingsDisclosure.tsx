import { useId, useState, type ReactNode } from 'react'

export default function SettingsDisclosure({ title, className, defaultExpanded = false, children }: {
  title: string; className: string; defaultExpanded?: boolean; children: ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const panelId = useId()
  return <div className={`settings-disclosure ${className}${expanded ? ' expanded' : ''}`}>
    <button type="button" className="ghost settings-disclosure-toggle" aria-expanded={expanded}
      aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
      <span>{title}</span>
      <svg className="settings-disclosure-chevron" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path className="chevron-left" d="M3 10H10" />
        <path className="chevron-right" d="M10 10H17" />
      </svg>
    </button>
    <div id={panelId} className="settings-disclosure-panel" inert={!expanded} aria-hidden={!expanded}>
      <div className="settings-disclosure-content">{children}</div>
    </div>
  </div>
}
