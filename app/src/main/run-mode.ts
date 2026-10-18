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
