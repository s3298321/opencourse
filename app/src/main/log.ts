/**
 * The app's logger. Import `log` and write: `log.child('openai').warn(...)`.
 *
 * It imports nothing from main on purpose, so any module - db.ts included - can
 * log without an import cycle. Where lines go (the database, the dev console)
 * and whose they are (the selected user) are wired once at startup by
 * main/logging.ts; until then, and in a unit test that never wires it, a log
 * line goes nowhere and costs nothing.
 *
 * Log metadata, never content: ids, models, statuses, durations, codes and
 * counts. Never a prompt, an answer, a transcript, a file's contents or a key.
 */
import { createLogger } from '../core/logging/logger'
import { scrubSecrets } from '../core/coach/key'

export const log = createLogger({
  scrub: scrubSecrets,
  // stderr, not a sink: a sink that is failing is the one thing that cannot be told.
  fallback: (text) => process.stderr.write(`${text}\n`)
})
