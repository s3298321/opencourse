/**
 * Seeds the e2e server the way a person would see it: accounts, published
 * courses and learners, through the real API - then makes `ada` an
 * administrator on the server's machine, as `npm run admin` does.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function globalSetup(): void {
  const server = resolve(import.meta.dirname, '..')
  const env = { ...process.env, OPENCOURSE_SERVER_URL: process.env['OPENCOURSE_E2E_URL'], OPENCOURSE_SERVER_DATA: process.env['OPENCOURSE_E2E_DATA'] }
  execFileSync(resolve(server, 'node_modules/.bin/tsx'), ['scripts/seed.ts'], { cwd: server, env, stdio: 'inherit' })
  execFileSync(process.execPath, ['dist/admin.js', 'grant-admin', 'ada'], { cwd: server, env, stdio: 'inherit' })
}
