import { validateProjectFiles } from './context'
import type { ExtraFile, ProjectModule } from '../types'

/** Course starters are seed data, never regenerated exercise support files. */
export function projectStarterPlan(module: ProjectModule): readonly ExtraFile[] {
  const files = module.project.starter_files ?? []
  const errors = validateProjectFiles(files)
  if (errors.length) throw new Error(errors.join('; '))
  return files
}
