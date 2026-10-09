import type { CourseItemRef, ReviewSession } from '@core/types'
/**
 * Where the app can be. No router: one union, switched on in App.tsx.
 *
 * `settings` and `logs` are the routes that remember where they were opened
 * from - the overlays - so closing one puts you back in the lesson you were
 * reading rather than at the top of the library. `Screen` exists to make that
 * safe: `from` cannot itself be an overlay, so `sectionOf` recurses exactly
 * once and the compiler, not a convention, is what guarantees it. Going from
 * one overlay to the other hands `from` along rather than nesting.
 */
export type Screen =
  | { name: 'users' }
  | { name: 'library'; tab?: 'mine' | 'catalog' }
  | { name: 'catalogCourse'; serverId: string; courseId: string }
  | { name: 'publication'; serverId: string; courseId: string }
  | { name: 'courseEditor'; courseId: string }
  | { name: 'course'; courseId: string }
  | { name: 'review'; session: ReviewSession }
  | { name: 'lesson'; courseId: string; moduleId: string; lessonId: string }
  | { name: 'project'; courseId: string; moduleId: string }
  | { name: 'coach' }
  | { name: 'coachProject'; projectId: string }
  | { name: 'coachSession'; projectId: string; sessionId: string }

export type Overlay =
  /** `section` scrolls Settings to one part of it, for a control elsewhere that is about that part. */
  | { name: 'settings'; from: Screen; section?: 'updates' }
  | { name: 'logs'; from: Screen }

export type Route = Screen | Overlay

/** The screen underneath: an overlay's `from`, or the route itself. */
export function screenOf(route: Route): Screen {
  return route.name === 'settings' || route.name === 'logs' ? route.from : route
}

/** Which half of the app a route belongs to, for the titlebar's switch. */
export function sectionOf(route: Route): 'courses' | 'coach' | null {
  switch (route.name) {
    case 'library':
    case 'catalogCourse':
    case 'publication':
    case 'courseEditor':
    case 'course':
    case 'review':
    case 'lesson':
    case 'project':
      return 'courses'
    case 'coach':
    case 'coachProject':
    case 'coachSession':
      return 'coach'
    case 'users':
      return null
    // An overlay borrows the half it was opened from, so the switch stays where
    // it was and going back is the only thing that moved.
    case 'settings':
    case 'logs':
      return sectionOf(route.from)
  }
}

export function itemRoute(courseId: string, item: { kind: 'lesson'; moduleId: string; lessonId: string } | { kind: 'project'; moduleId: string } | CourseItemRef): Screen {
  return item.kind === 'project' ? { name: 'project', courseId, moduleId: item.moduleId } : { name: 'lesson', courseId, moduleId: item.moduleId, lessonId: item.lessonId }
}
