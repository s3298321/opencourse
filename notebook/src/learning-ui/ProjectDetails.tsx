import type { ReactNode } from 'react'
import type { ProjectDefinition } from '../core/types'

interface Props {
  project: ProjectDefinition
  cardClassName: string
  renderText: (source: string, inline?: boolean) => ReactNode
}

export default function ProjectDetails({ project, cardClassName, renderText }: Props) {
  return <>
    <section className="project-requirements">
      <h2>Requirements</h2>
      <ol>{project.requirements.map(r => <li key={r.nodeId ?? r.id}>{renderText(r.description)}</li>)}</ol>
    </section>
    <section className="project-deliverables">
      <h2>Deliverables</h2>
      {project.deliverables.map(d => <div className={cardClassName} key={d.nodeId ?? d.id}>
        <h3>{renderText(d.title, true)}</h3>
        {renderText(d.description)}
        {!!d.paths?.length && <div className="project-paths">{d.paths.map(path => <code key={path}>{path}</code>)}</div>}
        <ul>{d.acceptance_criteria.map((criterion, i) => <li key={i}>{renderText(criterion)}</li>)}</ul>
      </div>)}
    </section>
  </>
}
