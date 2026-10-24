import type { JSX } from 'react'
import type { CourseManifest, Lesson, Module } from '@core/types'
import ActionButton from '../components/ActionButton'

export default function CourseEditorOutline({ manifest, selected, collapsed, manual, locked, onSelect, onToggle, onAddLesson, onAddModule }: {
  manifest: CourseManifest; selected: string | null; collapsed: string[]; manual: boolean; locked: boolean
  onSelect: (id: string | null) => void; onToggle: (id: string) => void
  onAddLesson: (moduleId: string) => void; onAddModule: (project?: boolean) => void
}): JSX.Element {
  const row = (element: Module | Lesson, depth: number): JSX.Element => {
    const title = element.title || 'Untitled', branch = 'lessons' in element, expanded = !collapsed.includes(element.nodeId!)
    return <div className="outline-entry" data-authoring-outline-id={element.nodeId} style={{ paddingLeft: depth * 16 }}>
      {branch ? <button className="outline-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`} title={`${expanded ? 'Collapse' : 'Expand'} ${title}`} onClick={() => onToggle(element.nodeId!)}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} /></svg>
      </button> : <span className="outline-toggle-space" aria-hidden="true" />}
      <button className={`outline-row${selected === element.nodeId ? ' selected' : ''}`} aria-label={title} title={title} aria-pressed={selected === element.nodeId} onClick={() => onSelect(element.nodeId!)}>
        {branch ? <svg className="outline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg> : <span className="outline-icon" aria-hidden="true">{'blocks' in element ? '▤' : '◇'}</span>}
        <span className="outline-label">{title}</span>
      </button>
    </div>
  }
  return <>
    <button className={`outline-row${selected === null ? ' selected' : ''}`} onClick={() => onSelect(null)}>Course details</button>
    {manifest.modules.map(module => <div key={module.nodeId}>
      {row(module, 0)}
      {module.type !== 'project' && !collapsed.includes(module.nodeId!) && <>
        {module.lessons.map(lesson => <div key={lesson.nodeId}>{row(lesson, 1)}</div>)}
        {manual && <button className="outline-add" disabled={locked} onClick={() => onAddLesson(module.nodeId!)}>+ Add lesson</button>}
      </>}
    </div>)}
    {manual && <div className="outline-bottom"><ActionButton icon="plus" className="secondary" disabled={locked} onClick={() => onAddModule()}>Add module</ActionButton><ActionButton icon="plus" className="secondary" disabled={locked} onClick={() => onAddModule(true)}>Add project</ActionButton></div>}
  </>
}
