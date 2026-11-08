import type { ProjectDefinition } from '@core/types'
import ProjectDetails from '../../learning-ui/ProjectDetails'
import Html from './Html'
import Objectives from './Objectives'

export default function ProjectBrief({ project }: { project: ProjectDefinition }) {
  return <>
    <Objectives title="What you will practice" objectives={project.objectives} />
    <Html className="project-definition prose" lesson source={project.definition} />
    <ProjectDetails project={project} cardClassName="panel" renderText={(source, inline = false) =>
      <Html className={inline ? undefined : 'prose'} as={inline ? 'span' : 'div'} lesson inline={inline} source={source} />
    } />
  </>
}
