/** Billable real-API gate; requires a production build and an explicit French speech WAV.
 * OPENCOURSE_TEST_COACH_LIVE=1 OPENAI_API_KEY=… OPENCOURSE_LIVE_AUDIO=/absolute/speech.wav
 * npm run build && npm test -- tests/coach-live-api.test.ts
 * No real profile, key, transcript or note content is included in the report.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const enabled = process.env['OPENCOURSE_TEST_COACH_LIVE'] === '1'
it.skipIf(!enabled)('connects real Live WebRTC, delegates tools, persists captions and resumes notes in a second session', async () => {
  expect(Boolean(process.env['OPENAI_API_KEY']), 'OPENAI_API_KEY is required').toBe(true)
  expect(Boolean(process.env['OPENCOURSE_LIVE_AUDIO']), 'OPENCOURSE_LIVE_AUDIO must name a French speech WAV').toBe(true)
  const temp = mkdtempSync(join(tmpdir(), 'coach-live-api-'))
  try {
    const report = join(temp, 'result.json')
    const dist = execFileSync(process.execPath, ['scripts/electron-dist.mjs'], {encoding: 'utf8'}).trim()
    let exitOkay = true
    await promisify(execFile)(process.execPath, ['node_modules/electron/cli.js', '.'], {
      timeout: 310_000, env: {...process.env, ELECTRON_OVERRIDE_DIST_PATH: dist, OPENCOURSE_COACH_LIVE_SMOKE: '1', OPENCOURSE_COACH_LIVE_REPORT: report},
      maxBuffer: 1024 * 1024
    }).catch(() => { exitOkay = false })
    const result = JSON.parse(readFileSync(report, 'utf8'))
    expect(result, 'Real-API parity report').toMatchObject({ok: true})
    expect(exitOkay).toBe(true)
    expect(result.checks).toHaveLength(7)
  } finally { rmSync(temp, {recursive: true, force: true}) }
}, 320_000)
