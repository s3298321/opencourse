import type { Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createSession } from '../src/auth/sessions'

// Seed a session for journeys that share the server's login rate limit.
export async function signInFixture(page: Page, username: string, url = process.env.OPENCOURSE_E2E_URL!): Promise<string> {
  const d = new DatabaseSync(join(process.env.OPENCOURSE_E2E_DATA!, 'server.db'))
  try {
    const account = String(d.prepare('SELECT id FROM accounts WHERE username=?').get(username)!.id)
    const webToken = createSession(d, account, { kind: 'web' })
    await page.context().addCookies([{ name: 'ocs_session', value: webToken, url, httpOnly: true, sameSite: 'Lax' }])
    return createSession(d, account, { kind: 'app' })
  } finally { d.close() }
}
