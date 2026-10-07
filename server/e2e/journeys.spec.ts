/**
 * The web app's journeys, asserting what a person sees - titles, pills,
 * toasts - rather than that elements exist. Seeded by global-setup.ts: `ada`
 * (an administrator) published the example course in three versions, `grace`
 * and four learners exist, all with the password below.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'correct horse battery'
const EXAMPLE = 'The OpenCourse example course'
const shot = (page: Page, name: string) => page.screenshot({ path: join(tmpdir(), `opencourse-web-${name}.png`), fullPage: false })

/** Fails the test on any script error or console error the page reports. */
function watch(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    // A 401 for /api/v1/me is how a signed-out page learns it is signed out.
    if (message.type() === 'error' && !/401|Transition was aborted/.test(message.text())) errors.push(message.text())
  })
  return errors
}

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/signin')
  await page.getByLabel('Email or username').fill(login)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: new RegExp(login) })).toBeVisible()
}

test('the catalog: search, a course, and how to add it', async ({ page }) => {
  const errors = watch(page)
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'")
  await expect(page).toHaveTitle('E2E Catalog')
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Catalog' })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(EXAMPLE) })).toBeVisible()
  await shot(page, 'catalog')

  await page.getByLabel('Search courses').first().fill('example')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page).toHaveURL(/\?q=example/)
  await expect(page.getByText(/1 course for/)).toBeVisible()

  await page.getByRole('link', { name: new RegExp(EXAMPLE) }).click()
  await expect(page.getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  await expect(page).toHaveTitle(`${EXAMPLE} · E2E Catalog`)
  await expect(page.getByRole('heading', { name: 'Contents' })).toBeVisible()
  await expect(page.getByText('1.0.0').first()).toBeVisible()
  await page.getByRole('button', { name: 'Add in OpenCourse' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add this course in OpenCourse' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Settings ▸ Servers ▸ Connect to a server…')).toBeVisible()
  await shot(page, 'course-dialog')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(errors).toEqual([])
})

test('signing up with the emailed code, and signing out', async ({ page, request }) => {
  const errors = watch(page)
  const email = `web-${Date.now()}@example.org`
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const outbox = await (await request.get('/dev/outbox')).json() as { messages: { to: string; text: string }[] }
  const code = outbox.messages.reverse().find((m) => m.to === email)!.text.match(/\b(\d{6})\b/)![1]!
  await page.getByLabel('Digit 1').fill(code)
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your name' })).toBeVisible()
  const username = `web${Date.now() % 100000}`
  await page.getByLabel('Username').fill(username)
  await expect(page.getByText('Available')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('a long enough password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText(`Welcome to E2E Catalog, ${username}.`)).toBeVisible()
  await shot(page, 'signed-up')

  // The session survives a reload: the server read the cookie and said who this is.
  await page.reload()
  await expect(page.getByRole('button', { name: new RegExp(username) })).toBeVisible()
  await page.getByRole('button', { name: new RegExp(username) }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  expect(errors).toEqual([])
})

test('a publisher rolls a course back to an older version', async ({ page }) => {
  const errors = watch(page)
  await signIn(page, 'ada')
  await page.goto('/me/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'My courses' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(EXAMPLE) }).click()
  await expect(page.getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  const row = page.locator('.version-row', { hasText: '0.2.0' })
  await row.getByRole('button', { name: 'Make current' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Make current' }).click()
  await expect(page.getByText('0.2.0 is now current.')).toBeVisible()
  await expect(row.getByText('Current')).toBeVisible()
  await shot(page, 'rollback')
  // And forward again, so the other journeys see 1.0.0.
  await page.locator('.version-row', { hasText: '1.0.0' }).getByRole('button', { name: 'Make current' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Make current' }).click()
  await expect(page.getByText('1.0.0 is now current.')).toBeVisible()
  expect(errors).toEqual([])
})

test('settings list where you are signed in, this browser first', async ({ page }) => {
  const errors = watch(page)
  await signIn(page, 'grace')
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.getByText('This browser')).toBeVisible()
  await expect(page.getByText(/Chrome on macOS|Chrome on Linux/)).toBeVisible()
  await shot(page, 'settings')
  expect(errors).toEqual([])
})

test('an administrator removes a course from the catalog and restores it', async ({ page, browser }) => {
  const errors = watch(page)
  await signIn(page, 'ada')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
  await page.getByRole('link', { name: 'Courses', exact: true }).click()
  const row = page.getByRole('row', { name: new RegExp(EXAMPLE) })
  await row.getByRole('button', { name: 'Remove' }).click()
  await page.getByLabel('Reason, for the publisher').fill('Testing moderation.')
  await page.getByRole('button', { name: 'Remove from catalog' }).click()
  await expect(page.getByText(`“${EXAMPLE}” was removed from the catalog.`)).toBeVisible()
  await expect(row.getByText('Moderated')).toBeVisible()
  await shot(page, 'admin-moderated')

  // A stranger no longer finds it, and its page is a 404.
  const stranger = await browser.newPage()
  await stranger.goto('/?q=example')
  await expect(stranger.getByText('No courses')).toBeVisible()
  await stranger.close()

  await row.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText(`“${EXAMPLE}” is back in the catalog.`)).toBeVisible()
  await page.goto('/admin/audit')
  await expect(page.getByText('Testing moderation.')).toBeVisible()
  expect(errors).toEqual([])
})

test('a member is kept out of the admin console', async ({ page }) => {
  await signIn(page, 'grace')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Not for this account' })).toBeVisible()
})
