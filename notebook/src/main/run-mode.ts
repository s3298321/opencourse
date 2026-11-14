import { app } from 'electron'

/**
 * Smoke, screenshot and live-check runs: a throwaway profile (index.ts), and
 * nothing that reaches out on its own - no update check, no download. One list,
 * so the two cannot disagree about what counts as a test run.
 */
export const isolatedRun = Boolean(
  process.env['OPENCOURSE_SMOKE'] ||
  process.env['OPENCOURSE_SHOTS'] ||
  process.env['OPENCOURSE_LIVE_CHECK'] ||
  process.env['OPENCOURSE_FLASHCARD_SMOKE']
)

/**
 * `npm run dev`: a profile of its own (`opencourse-dev`, under the name
 * "OpenCourse Dev", so its keychain item and instance lock are its own too),
 * seeded and pointed at the local server and site (dev-env.ts). A packaged
 * build ignores the variable, and a test run keeps its throwaway profile.
 */
export function devRun(): boolean {
  return process.env['OPENCOURSE_DEV'] === '1' && !isolatedRun && app?.isPackaged === false
}
