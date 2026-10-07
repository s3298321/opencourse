/**
 * The web app's journeys in a real browser: `npm run e2e` (after `npm run build`).
 *
 * Opt-in, like the app's live suites: it starts the *built* server in
 * development mode on a throwaway data directory, seeds it through the real API
 * (scripts/seed.ts) and drives Chrome - the copy installed on this Mac, or
 * Playwright's own if `PLAYWRIGHT_CHANNEL=chromium`. Screenshots of each
 * journey land in os.tmpdir() as opencourse-web-*.png.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const port = Number(process.env['OPENCOURSE_E2E_PORT'] ?? 8798)
const data = process.env['OPENCOURSE_E2E_DATA'] ?? mkdtempSync(join(tmpdir(), 'opencourse-e2e-'))
process.env['OPENCOURSE_E2E_DATA'] = data
process.env['OPENCOURSE_E2E_URL'] = `http://127.0.0.1:${port}`
const server = resolve(import.meta.dirname, '..')

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env['PLAYWRIGHT_CHANNEL'] ?? 'chrome',
    viewport: { width: 1280, height: 860 },
    colorScheme: 'dark'
  },
  webServer: {
    command: 'node dist/index.js',
    cwd: server,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      OPENCOURSE_SERVER_DEV: '1',
      OPENCOURSE_SERVER_HOST: '127.0.0.1',
      OPENCOURSE_SERVER_PORT: String(port),
      OPENCOURSE_SERVER_DATA: data,
      OPENCOURSE_SERVER_NAME: 'E2E Catalog',
      OPENCOURSE_SERVER_DESCRIPTION: 'A catalog for the browser journeys.'
    }
  }
})
