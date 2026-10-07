/**
 * Every path the app owns, derived from one root.
 *
 * That root is `app.getPath('userData')`, so a smoke or screenshot run only has
 * to call `app.setPath('userData', <tmpdir>)` once (main/index.ts) to isolate
 * courses, progress, exercise files and virtualenvs in a single stroke. Keep
 * these lazy - that override lands before app.whenReady(), and a value captured
 * at module load would miss it.
 *
 * The app ships no courses. `content/` in the repo is authoring input for
 * `npm run validate:content`; nothing reads it at runtime.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { assertSafeSegment } from '../core/scaffold'

/** ~/Library/Application Support/opencourse */
export function dataRoot(): string {
  return app.getPath('userData')
}

export function usersFile(): string {
  return join(dataRoot(), 'users.json')
}

/**
 * The app's log - main/logdb.ts. The one thing under userData that is not per
 * user, because some lines belong to nobody: startup, a crash, anything before
 * the picker. Each row carries the user it was written under, and the Logs page
 * only ever reads that user's rows and the general ones.
 */
export function logDbFile(): string {
  return join(dataRoot(), 'logs.db')
}

/** Everything one user owns, in one deletable directory. */
export function userDir(id: string): string {
  return join(dataRoot(), 'users', assertSafeSegment(id, 'user id'))
}

export function userCoursesDir(id: string): string {
  return join(userDir(id), 'courses')
}

export function userProgressDir(id: string): string {
  return join(userDir(id), 'progress')
}

/** Where exercise folders and per-course virtualenvs are written. */
export function userWorkspaceRoot(id: string): string {
  return join(userDir(id), 'workspace')
}

export function userProfileFile(id: string): string {
  return join(userDir(id), 'profile.json')
}

/** Settings that are neither the name nor the key - core/preferences.ts. */
export function userPreferencesFile(id: string): string {
  return join(userDir(id), 'preferences.json')
}

/**
 * Favicons of pages the side chat cited - main/favicons.ts. Per user like
 * everything else, so which sites someone's answers cited goes when they do.
 */
export function userFaviconDir(id: string): string {
  return join(userDir(id), 'cache', 'favicons')
}

/**
 * Installed themes - main/themes.ts. One directory per theme, named by its
 * app-local UUID, holding `files/` (the archive as imported) and `meta.json`
 * (the app's own record, which no archive can overwrite).
 */
export function userThemesDir(id: string): string {
  return join(userDir(id), 'themes')
}

export function userThemeDir(id: string, themeId: string): string {
  return join(userThemesDir(id), assertSafeSegment(themeId, 'theme id'))
}

/* --- servers -------------------------------------------------------------- */

/**
 * The OpenCourse servers this user has connected to: `servers.json` (addresses,
 * account names) and one keychain-sealed `<connection>.token` per connection.
 * Per user, so a deleted user's connections and tokens go with them.
 */
export function userServersDir(id: string): string {
  return join(userDir(id), 'servers')
}

export function serverTokenFile(id: string, connectionId: string): string {
  return join(userServersDir(id), `${assertSafeSegment(connectionId, 'server connection id')}.token`)
}

/* --- coach ---------------------------------------------------------------- */

/** Everything one user's coaching costs them: a database, a key, workspaces. */
export function userCoachDir(id: string): string {
  return join(userDir(id), 'coach')
}

/**
 * The user's database - Coach's projects and transcripts, and side chat's
 * conversations. (The log is the only other one, and it is app-wide - see
 * `logDbFile`.) Per user rather than app-wide so that `deleteUser`'s
 * single rmSync takes all of it and the key with it, and so no query can ever
 * forget a `WHERE user_id = ?`.
 *
 * Still named coach.db, and still under coach/, because it was Coach's first:
 * renaming it would mean migrating live transcripts for a cosmetic win.
 */
export function userDbFile(id: string): string {
  return join(userCoachDir(id), 'coach.db')
}

/** safeStorage ciphertext, deliberately a file rather than a database row. */
export function coachKeyFile(id: string): string {
  return join(userCoachDir(id), 'openai.key')
}

export function coachProjectsRoot(id: string): string {
  return join(userCoachDir(id), 'projects')
}

/** Where a coach's own files land. The id is a path segment, so it is checked. */
export function coachProjectDir(id: string, projectId: string): string {
  return join(coachProjectsRoot(id), assertSafeSegment(projectId, 'coach project id'))
}

/**
 * The course-format spec, schema and example archive, generated into
 * app/resources/spec by scripts/build-spec-resources.mjs and shipped as
 * extraResources so the app can hand an author a copy.
 */
export function specResourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'spec') : join(app.getAppPath(), 'resources', 'spec')
}

/** Course projects have their own namespace, separate from exercise and Coach files. */
export function courseProjectsRoot(id: string): string { return join(userDir(id), 'course-projects') }
export function courseProjectDir(id: string, courseId: string, moduleId: string): string {
  return join(courseProjectsRoot(id), assertSafeSegment(courseId, 'course slug'), assertSafeSegment(moduleId, 'project module slug'))
}

export function courseProjectStateDir(id: string, courseId: string): string {
  return join(userDir(id), 'course-project-state', assertSafeSegment(courseId, 'course slug'))
}
