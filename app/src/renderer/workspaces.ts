import { screenOf, sectionOf, type Route, type Screen } from './routes'

export type Workspace = 'courses' | 'documents' | 'coach'
export interface WorkspaceNavigation {
  route: Route
  courses: Screen | null
  documents: Screen | null
  coach: Screen | null
}

export const initialNavigation = (): WorkspaceNavigation => ({ route: { name: 'users' }, courses: null, documents: null, coach: null })

/** Only real navigation replaces a screen; overlays and section switches park it. */
export function navigateWorkspace(state: WorkspaceNavigation, route: Route): WorkspaceNavigation {
  if (route.name === 'users') return initialNavigation()
  const section = sectionOf(route)
  return section ? { ...state, route, [section]: screenOf(route) } : { ...state, route }
}

export function switchWorkspace(state: WorkspaceNavigation, section: Workspace): WorkspaceNavigation {
  if (sectionOf(state.route) === section && state.route.name !== 'settings' && state.route.name !== 'logs') return state
  const route = state[section] ?? (section === 'courses' ? { name: 'library' } : section === 'documents' ? { name: 'documents' } : { name: 'coach' })
  return navigateWorkspace(state, route as Screen)
}

export function screenKey(screen: Screen): string {
  // Library's selected source and lesson navigation are props, not new screen instances.
  switch (screen.name) {
    case 'library': return 'library'
    case 'catalog': return `catalog/${screen.serverId}`
    case 'lesson': return `lesson/${screen.courseId}`
    case 'project': return `project/${screen.courseId}/${screen.moduleId}`
    case 'notebook': case 'course': case 'courseEditor': return `${screen.name}/${screen.courseId}`
    case 'catalogCourse': case 'publication': return `${screen.name}/${screen.serverId}/${screen.courseId}`
    case 'coachProject': return `coachProject/${screen.projectId}`
    case 'document': return `document/${screen.documentId}`
    case 'coachSession': return `coachSession/${screen.projectId}/${screen.sessionId}`
    case 'review': return `review/${screen.session.id}`
    default: return screen.name
  }
}
