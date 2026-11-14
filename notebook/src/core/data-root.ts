import { join } from 'node:path'

/** Directory the main OpenCourse app uses for users, notebooks, chat, and credentials. */
export function opencourseDataRoot(appData: string, dev: boolean): string {
  return join(appData, dev ? 'opencourse-dev' : 'opencourse')
}

/** This app's Electron profile: single-instance lock, cache, and GPU files. */
export function notebookProfileRoot(appData: string, dev: boolean): string {
  return join(appData, dev ? 'opencourse-notebook-dev' : 'opencourse-notebook')
}
