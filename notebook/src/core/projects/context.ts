import type { ExtraFile, ProjectModule } from '../types'
import { assertSafeRelativePath } from '../scaffold'

export function validateProjectFiles(files: readonly ExtraFile[]): string[] {
  const errors: string[] = []
  const paths = new Set<string>()
  let bytes = 0
  for (const file of files) {
    try { assertSafeRelativePath(file.path, 'project starter path') } catch { errors.push(`invalid starter path: ${file.path}`) }
    if (paths.has(file.path)) errors.push(`duplicate starter path: ${file.path}`)
    paths.add(file.path)
    const fileBytes = new TextEncoder().encode(file.content).length
    bytes += fileBytes
    if (fileBytes > 256 * 1024) errors.push(`starter file too large: ${file.path}`)
  }
  for (const path of paths) {
    const segments = path.split('/')
    for (let n = 1; n < segments.length; n++) {
      if (paths.has(segments.slice(0, n).join('/'))) errors.push(`starter file/directory collision: ${path}`)
    }
  }
  if (bytes > 1024 * 1024) errors.push('project starter files exceed 1 MiB')
  return errors
}

export function projectContextText(courseTitle: string, module: ProjectModule): string {
  const p = module.project
  return [
    `Course: ${courseTitle}\nProject: ${module.title}`,
    p.objectives?.length ? `Learning objectives:\n${p.objectives.map((o) => `- ${o}`).join('\n')}` : '',
    `Definition:\n${p.definition}`,
    `Requirements:\n${p.requirements.map((r) => `- [${r.id}] ${r.description}`).join('\n')}`,
    `Deliverables:\n${p.deliverables.map((d) => `### [${d.id}] ${d.title}\n${d.description}\n${d.paths?.length ? `Suggested files: ${d.paths.join(', ')}\n` : ''}Acceptance criteria:\n${d.acceptance_criteria.map((c) => `- ${c}`).join('\n')}`).join('\n\n')}`
  ].filter(Boolean).join('\n\n')
}
