/**
 * The web app's journeys, asserting what a person sees - titles, pills,
 * toasts - rather than that elements exist. Seeded by global-setup.ts: `ada`
 * (an administrator) published the example course in three versions, `grace`
 * and four learners exist, all with the password below.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { makeZip } from '../../app/tests/helpers/zip'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'correct horse battery'
const EXAMPLE = 'The OpenCourse example course'
const shot = async (page: Page, name: string) => {
  // Let finite entrances and route transitions finish before capturing their final layout.
  await page.evaluate(`(async () => {
    await Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    await document.fonts.ready
  })()`)
  return page.screenshot({ path: join(tmpdir(), `opencourse-web-${name}.png`), fullPage: false })
}

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

test('the catalog: search, a course, and adding it asks for an account', async ({ page }) => {
  const errors = watch(page)
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'")
  await expect(page).toHaveTitle('E2E Catalog')
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Catalog' })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(EXAMPLE) })).toBeVisible()
  await shot(page, 'catalog')
  await page.getByLabel('Search courses').first().fill('nothing-matches-this-course');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nothing matches that' })).toBeVisible();
  await expect(page.locator('.empty-art .sparkles')).toBeVisible();
  await page.locator('.empty-state').scrollIntoViewIfNeeded()
  await shot(page, 'catalog-empty')

  await page.getByLabel('Search courses').first().fill('example')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page).toHaveURL(/\?q=example/)
  await expect(page.getByText(/1 course for/)).toBeVisible()

  await page.getByRole('link', { name: new RegExp(EXAMPLE) }).click()
  await expect(page.getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  await expect(page).toHaveTitle(`${EXAMPLE} · E2E Catalog`)
  await expect(page.getByRole('heading', { name: 'Contents' })).toBeVisible()
  await expect(page.getByText('1.0.0').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Learn on the web' })).toHaveCount(0)
  await expect(page.getByText('Add this course', { exact: true })).toHaveCount(0)
  await shot(page, 'course')
  // Signed out, adding asks for an account first and comes back here.
  await page.getByRole('button', { name: 'Add to library' }).click()
  await expect(page).toHaveURL(/\/signin\?next=%2Fcourses%2F/)
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
  await expect(page.getByRole('heading', { level: 1, name: 'My publications' })).toBeVisible()
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
  await page.getByRole('navigation', { name: 'Administration' }).getByRole('link', { name: 'Courses', exact: true }).click()
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

test('web learning: enroll, resume progress, review, and keep app activities visible', async ({ page }) => {
  const errors = watch(page)
  await signIn(page, 'lin')
  await page.goto('/')
  await page.getByRole('link', { name: new RegExp(EXAMPLE) }).click()
  await page.getByRole('button', { name: 'Add to library' }).click()
  // Adding opens the course's overview, the app's course screen; review is started there, never inside a lesson.
  await expect(page).toHaveURL(/\/learning\/courses\//)
  await expect(page.getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  await expect(page.getByText('Complete a lesson with flashcards to unlock review.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeDisabled()
  await page.getByRole('link', { name: 'Start course', exact: true }).click()
  await expect(page).toHaveURL(/\/learn\/course\//)
  await expect(page.getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Course outline' })).toBeVisible()
  const outline = page.getByRole('navigation', { name: 'Course outline' })
  await expect(page.getByLabel('Course section')).toHaveCount(0)
  await expect(outline.getByRole('button', { name: /Hello, Python/ })).toHaveAttribute('aria-current', 'page')
  const size = page.getByRole('group', { name: 'Text size', exact: true })
  await expect(size).toBeVisible()
  await size.getByRole('button', { name: 'Larger text' }).click()
  await expect(size.getByRole('button', { name: 'Text size 110%. Press to type a size', exact: true })).toBeVisible()
  await size.getByRole('button', { name: 'Text size 110%. Press to type a size', exact: true }).click()
  await size.getByRole('textbox').fill('130')
  await size.getByRole('textbox').press('Enter')
  await expect(page.getByRole('status', { name: 'Progress saving status' })).toHaveText('Progress saved')
  await page.reload()
  await expect(size.getByRole('button', { name: 'Text size 130%. Press to type a size', exact: true })).toBeVisible()
  await size.getByRole('button', { name: 'Text size 130%. Press to type a size', exact: true }).click()
  await size.getByRole('textbox').fill('100')
  await size.getByRole('textbox').press('Enter')
  await page.getByRole('button', { name: 'Mark lesson completed', exact: true }).click()
  const read = page.getByRole('button', { name: 'Lesson completed', exact: true })
  await expect(read).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('status', { name: 'Progress saving status' })).toHaveText('Progress saved')
  await page.reload()
  await expect(read).toHaveAttribute('aria-pressed', 'true')
  // An exercise opens in a workspace like the app's, and its code is saved as progress.
  await page.getByRole('button', { name: 'Start exercise', exact: true }).click()
  const workspace = page.locator('.web-workbench')
  await expect(workspace.getByText('Running the checks and the terminal happen in the desktop app.', { exact: false })).toBeVisible()
  const editor = workspace.getByRole('textbox', { name: 'Code editor' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n# written on the web')
  await expect(workspace.getByRole('status', { name: 'Code saving status' })).toHaveText('Saved')
  await shot(page, 'exercise-workspace')
  await page.reload()
  // Back to lesson returns to where the lesson was left, not to its top.
  const resume = page.getByRole('button', { name: 'Continue exercise', exact: true })
  await resume.scrollIntoViewIfNeeded()
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(300)
  const leftAt = (await page.evaluate('window.scrollY')) as number
  expect(leftAt).toBeGreaterThan(0)
  await resume.click()
  await expect(page.getByRole('textbox', { name: 'Code editor' })).toContainText('# written on the web')
  await page.getByRole('button', { name: 'Back to lesson', exact: true }).click()
  await expect(page.locator('.web-workbench')).toHaveCount(0)
  await expect.poll(async () => Math.round((await page.evaluate('window.scrollY')) as number)).toBe(Math.round(leftAt))
  const launcher = page.getByRole('button', { name: 'Open reading chat' })
  const chat = page.getByRole('complementary', { name: 'Reading chat' })
  await expect(launcher).toHaveAttribute('aria-expanded', 'false')
  await expect(chat).toBeHidden()
  await page.evaluate('window.scrollTo(0, 0)')
  await page.setViewportSize({ width: 1672, height: 972 })
  const content = page.locator('.web-reading')
  const beforeChat = (await content.boundingBox())!
  const outlineBox = (await page.locator('.course-reading-outline').boundingBox())!
  const fixedSize = (await size.boundingBox())!
  expect(fixedSize.x).toBeCloseTo(outlineBox.x + outlineBox.width + 16, 0)
  expect(fixedSize.y + fixedSize.height).toBeCloseTo(972 - 16, 0)
  expect(outlineBox.x).toBeLessThanOrEqual(24)
  const workspaceCenter = (outlineBox.x + outlineBox.width + 1672 - 24) / 2
  expect(beforeChat.x + beforeChat.width / 2).toBeCloseTo(workspaceCenter, 0)
  expect((await page.locator('.outline-course-header > .back-link').boundingBox())!.x).toBeLessThanOrEqual(24)
  expect(beforeChat.width).toBeCloseTo(820, 0)
  await expect(content).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(content).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.lesson-eyebrow, .outline-progress, .outline-heading')).toHaveCount(0)
  await expect(page.locator('.outline-course-header').getByRole('heading', { level: 1, name: EXAMPLE })).toBeVisible()
  await expect(page.getByText('Your learning, in sync', { exact: true })).toHaveCount(0)
  await shot(page, 'learning-chat-closed')
  await launcher.click()
  await expect(launcher).toBeHidden()
  await expect.poll(async () => (await content.boundingBox())!.width).toBeCloseTo(beforeChat.width, 0)
  await expect.poll(async () => {
    const reading = (await content.boundingBox())!, card = (await chat.boundingBox())!
    return (reading.x + card.x + card.width) / 2
  }).toBeCloseTo(workspaceCenter, 0)
  expect((await content.boundingBox())!.x).toBeLessThan(beforeChat.x)
  expect((await size.boundingBox())!.x).toBeCloseTo(fixedSize.x, 0)
  await expect.poll(async () => (await chat.boundingBox())!.height).toBeGreaterThan(850)
  const fullHeight = (await chat.boundingBox())!
  const header = (await page.locator('.site-header').boundingBox())!
  const chatTop = header.y + header.height + 16
  expect(fullHeight.y).toBeCloseTo(chatTop, 0)
  expect(fullHeight.y + fullHeight.height).toBeCloseTo(956, 0)
  await expect(page.getByText('Select a passage to include it in your question.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Shift + Enter for a new line', { exact: true })).toHaveCount(0)
  await shot(page, 'learning-chat-wide')
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await expect(launcher).toBeVisible()
  await expect.poll(async () => (await content.boundingBox())!.width).toBeCloseTo(beforeChat.width, 0)
  await expect.poll(async () => (await content.boundingBox())!.x).toBeCloseTo(beforeChat.x, 0)
  await page.setViewportSize({ width: 1280, height: 450 })
  const title = page.locator('.outline-course-header h1')
  const titleBeforeScroll = (await title.boundingBox())!
  const navigationScroll = page.locator('.outline-content')
  await navigationScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(await navigationScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect((await title.boundingBox())!.y).toBeCloseTo(titleBeforeScroll.y)
  await navigationScroll.evaluate((element) => { element.scrollTop = 0 })
  await page.setViewportSize({ width: 1280, height: 860 })
  await launcher.click()
  await expect(chat).toBeVisible()
  await expect(page.getByText('Configure an API key in this server’s settings')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  const question = page.getByRole('textbox', { name: 'Your question' })
  await expect(question).toBeFocused()
  await question.fill('Keep this question while I read.')
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await expect(chat).toBeHidden()
  await expect(launcher).toBeFocused()
  await launcher.click()
  await expect(question).toHaveValue('Keep this question while I read.')
  await page.keyboard.press('Escape')
  await expect(chat).toBeHidden()
  // The launch control remains at the course's top-right as the page scrolls.
  // (Within the lesson: at the footer the sticky outline rightly scrolls away with it.)
  await page.evaluate('window.scrollTo(0, 500)')
  await expect(launcher).toBeVisible()
  const outlinePosition = await outline.boundingBox()
  expect(outlinePosition!.y).toBeGreaterThanOrEqual(60)
  expect(outlinePosition!.x).toBeLessThan((await page.locator('.web-reading').boundingBox())!.x)
  const sizePosition = await size.boundingBox()
  const sidebarPosition = (await page.locator('.course-reading-outline').boundingBox())!
  expect(sizePosition!.x).toBeCloseTo(sidebarPosition.x + sidebarPosition.width + 16, 0)
  expect(sizePosition!.y + sizePosition!.height).toBeLessThan(860)
  const sticky = await launcher.boundingBox()
  expect(sticky!.y).toBeGreaterThanOrEqual(60)
  expect(sticky!.y).toBeLessThan(110)
  await launcher.click()
  await expect(chat).toBeVisible()
  await expect(launcher).toBeHidden()
  await expect.poll(async () => (await chat.boundingBox())!.height).toBeCloseTo(860 - chatTop - 16, 0)
  expect((await chat.boundingBox())!.y).toBeCloseTo(chatTop, 0)
  await shot(page, 'learning-chat-scrolled')
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await page.evaluate('window.scrollTo(0, 0)')
  await expect(page.getByRole('heading', { name: 'Hello, Python', exact: true })).toHaveCount(1)
  // A highlight is an offer, not a question: the chat opens only when it is pressed.
  await page.locator('.lesson-prose p strong').first().dblclick()
  const offer = page.getByRole('button', { name: 'Ask about this', exact: true })
  await expect(offer).toBeVisible()
  await expect(chat).toBeHidden()
  await shot(page, 'learning-ask-offer')
  await offer.click()
  await expect(offer).toBeHidden()
  await expect(chat).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove selected passage' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove selected passage' }).click()
  await question.fill('')
  await expect.poll(async () => { const box = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox(); return box!.y + box!.height }).toBeLessThan(860)
  await shot(page, 'learning')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(chat).toBeVisible()
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
  await expect.poll(async () => { const box = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox(); return box!.y + box!.height }).toBeLessThan(844)
  await expect(launcher).toBeHidden()
  await expect.poll(async () => (await chat.boundingBox())!.height).toBeCloseTo(844 - chatTop - 16, 0)
  await shot(page, 'learning-chat-mobile')
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await expect(chat).toBeHidden()
  await page.getByRole('button', { name: 'Course outline', exact: true }).click()
  await expect(outline).toBeVisible()
  await outline.getByRole('button', { name: /Hello, Python/ }).click()
  await expect(page.getByRole('button', { name: 'Course outline', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => {
    const heading = (await page.getByRole('heading', { name: 'Hello, Python', exact: true }).boundingBox())!
    const sidebar = (await page.locator('.course-reading-outline').boundingBox())!
    return heading.y >= sidebar.y + sidebar.height
  }).toBe(true)
  await shot(page, 'learning-mobile')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await launcher.click()
  await expect(chat).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(chat).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1280, height: 860 })
  const entries = outline.getByRole('button')
  const count = await entries.count()
  let appRequired = false
  for (let index = 0; index < count; index++) {
    await entries.nth(index).click()
    await expect(entries.nth(index)).toHaveAttribute('aria-current', 'page')
    if (await page.getByText('Complete this activity in the desktop app.', { exact: true }).count()) { appRequired = true; break }
  }
  // Navigation through the outline persists the selected section, including projects.
  const project = outline.getByRole('button', { name: /Project workspace/ }).first()
  await project.click()
  await expect(project).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('status', { name: 'Progress saving status' })).toHaveText('Progress saved')
  await page.reload()
  await expect(project).toHaveAttribute('aria-current', 'page')
  expect(appRequired).toBe(true)
  await expect(page.getByText('Reveal answer')).toHaveCount(0)
  // The completed lesson's flashcards are reviewed in a session from the overview.
  await page.getByRole('link', { name: 'Course overview', exact: true }).click()
  await expect(page.getByText('New cards ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page).toHaveURL(/\/review\?cards=10$/)
  await expect(page.getByRole('status').filter({ hasText: /^0 \/ \d+ reviewed$/ })).toBeVisible()
  const cards = Number((await page.getByRole('status').filter({ hasText: /reviewed$/ }).textContent())!.split('/ ')[1]!.split(' ')[0])
  for (let n = 0; n < cards; n++) {
    await expect(page.getByText(`Card ${n + 1} of ${cards}`, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Reveal answer/ })).toBeEnabled()
    await page.keyboard.press('Space')
    await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible()
    await page.getByRole('button', { name: 'Good', exact: true }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Review complete' })).toBeVisible()
  await shot(page, 'review-complete')
  await page.getByRole('button', { name: 'Back to course' }).first().click()
  await expect(page.getByText(/^Next review /)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue', exact: true })).toBeVisible()
  await shot(page, 'learning-course')
  // Being caught up still allows a complete early review session.
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled()
  await expect(page.locator('.learning-review-counts')).toContainText('0 due · 0 new')
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  for (let n = 0; n < cards; n++) {
    await expect(page.getByText(`Card ${n + 1} of ${cards}`, { exact: true })).toBeVisible()
    await expect(page.getByText('Early review', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Reveal answer/ }).click()
    await page.getByRole('button', { name: 'Good', exact: true }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Review complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to course' }).first().click()
  await page.getByRole('link', { name: 'My learning', exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'My learning' })).toBeVisible()
  // The whole card is the link to the course; it has no buttons of its own.
  const card = page.locator('.learning-grid a.library-card-link', { hasText: EXAMPLE })
  await expect(card).toHaveAttribute('href', /^\/learning\/courses\//)
  await expect(page.locator('.learning-grid button')).toHaveCount(0)
  await shot(page, 'my-learning')
  await page.getByRole('button', { name: /Documents 0/ }).click()
  await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible()
  expect(errors).toEqual([])
})


test('document catalog has useful empty states and fits a narrow screen', async ({ page }) => {
  const errors = watch(page)
  await page.goto('/documents')
  await expect(page.getByText('Documents published to this server will appear here.')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Document pages' })).toHaveCount(0)
  await shot(page, 'documents-empty')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('searchbox', { name: 'Search documents' }).fill('missing document')
  await expect(page.getByRole('heading', { name: 'No documents found' })).toBeVisible()
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
  await shot(page, 'documents-mobile')
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByText('Documents published to this server will appear here.')).toBeVisible()
  expect(errors).toEqual([])
})

test('PDF catalog enrollment, searchable reading, and progress survive reload', async ({page,request}) => {
  const errors=watch(page), id=randomUUID(),work=mkdtempSync(join(tmpdir(),'opencourse-pdf-e2e-'))
  const stream='BT /F1 12 Tf 20 100 Td (A searchable learning document) Tj ET'
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf='%PDF-1.4\n';const offsets:number[]=[]
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`})
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  try {
    const login=await request.post('/api/v1/auth/login',{data:{login:'lin',password:PASSWORD}})
    expect(login.ok()).toBe(true)
    const {token}=await login.json()
    const file=makeZip(join(work,'document.zip'),[{name:'document.json',content:JSON.stringify({title:'Browser PDF',description:'A readable document',version:'1.0.0',tags:[]})},{name:'document.pdf',content:pdf}])
    const published=await request.post(`/api/v1/documents/${id}/versions`,{headers:{authorization:`Bearer ${token}`,'content-type':'application/zip'},data:readFileSync(file)})
    expect(published.status(),await published.text()).toBe(201)
    await signIn(page,'lin')
    await page.goto('/documents')
    await expect(page.getByRole('link',{name:'Browser PDF',exact:true})).toBeVisible()
    await shot(page, 'documents')
    await page.getByRole('link',{name:'Browser PDF',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Browser PDF',exact:true})).toBeVisible()
    await expect(page.locator('.document-overview .page-header')).toHaveCSS('opacity', '1')
    await shot(page, 'document-overview')
    await page.getByRole('button',{name:'Add to My learning'}).click()
    await expect(page).toHaveURL(new RegExp(`/learn/document/${id}`))
    const canvas=page.getByLabel('PDF page 1')
    await expect(canvas).toBeVisible()
    await expect.poll(()=>canvas.evaluate((element)=> (element as unknown as {width:number}).width)).toBeGreaterThan(300)
    // Reading looks like the app's: no kind and version label, and removing is the library card's job.
    await expect(page.getByRole('heading',{level:1,name:'Browser PDF'})).toBeVisible()
    await expect(page.getByText('Document · v1.0.0')).toHaveCount(0)
    await expect(page.getByRole('button',{name:/Remove/})).toHaveCount(0)
    await page.getByRole('button',{name:'Mark progress'}).click()
    await expect(page.getByRole('status', { name: 'Progress saving status' })).toHaveText('Progress saved')
    await page.reload()
    await expect(page.locator('.document-progress-percent')).toHaveText('100%')
    await page.getByRole('button',{name:'Find',exact:true}).click()
    await page.getByRole('searchbox',{name:'Find in document'}).fill('searchable')
    await expect(page.getByRole('button',{name:/Page 1.*searchable/})).toBeVisible()
    await shot(page,'pdf-reading')
    await page.setViewportSize({width:390,height:844})
    await expect(canvas).toBeVisible()
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    await shot(page, 'pdf-mobile')
    await page.setViewportSize({width:1280,height:800})
    await page.goto('/learning')
    await page.getByRole('button',{name:'Documents'}).click()
    const card=page.locator('.library-card',{hasText:'Browser PDF'})
    page.once('dialog',(dialog)=>void dialog.accept())
    await card.getByRole('button',{name:'Remove'}).click()
    await expect(card).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {rmSync(work,{recursive:true,force:true})}
})

test('reading chat tabs: local drafts, retained history, reopening and deletion', async ({ page }) => {
  const errors = watch(page)
  await signIn(page, 'lin')
  await page.goto('/')
  await page.getByRole('link', { name: new RegExp(EXAMPLE) }).click()
  // Already added by another journey or not, the course opens on its overview.
  await page.getByRole('button', { name: 'Add to library' }).or(page.getByRole('link', { name: 'Open course' })).click()
  await page.getByRole('link', { name: /^(Start course|Continue)$/ }).click()
  await expect(page).toHaveURL(/\/learn\/course\//)
  const contentId = new URL(page.url()).pathname.split('/').at(-1)!
  type View = import('../../app/src/core/learning/types').LearningChatView
  const stored = new Map<string, View>()
  for (const [id, title] of [['first', 'Understanding Python variables'], ['second', 'How does bytecode work?']]) {
    stored.set(id, {
      chat: { id, title, kind: 'course', contentId, version: '1.0.0', createdAt: '2026-10-19T12:00:00Z', messages: 1 },
      messages: [{ id: `${id}-message`, chatId: id, role: 'user', text: title, status: 'complete', at: '2026-10-19T12:00:00Z', citations: [] }]
    })
  }
  let created = 0
  await page.route('**/api/v1/me/ai', route => route.fulfill({ json: { configured: true, enabled: true } }))
  await page.route('**/api/v1/learning/chats**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, id = path.split('/')[5]
    if (req.method() === 'DELETE') { stored.delete(id); return route.fulfill({ json: { ok: true } }) }
    if (req.method() === 'POST' && path.endsWith('/messages')) {
      const body = req.postDataJSON(), view = stored.get(id)!
      view.chat.title = body.text
      view.chat.messages = 2
      view.messages = [
        { id: 'question', chatId: id, role: 'user', text: body.text, status: 'complete', at: '2026-10-19T12:01:00Z', citations: [] },
        { id: 'answer', chatId: id, role: 'assistant', text: 'A deterministic test answer.', status: 'complete', at: '2026-10-19T12:01:01Z', citations: [] }
      ]
      return route.fulfill({ json: { messageId: 'answer' } })
    }
    if (req.method() === 'POST') {
      created++
      const view: View = { chat: { id: `new-${created}`, title: '', kind: 'course', contentId, version: '1.0.0', createdAt: '2026-10-19T12:01:00Z', messages: 0 }, messages: [] }
      stored.set(view.chat.id, view)
      return route.fulfill({ json: view })
    }
    return route.fulfill({ json: id ? stored.get(id) : { chats: [...stored.values()].map(v => v.chat) } })
  })
  await page.setViewportSize({ width: 1672, height: 972 })
  await page.getByRole('button', { name: 'Open reading chat' }).click()
  const tabs = page.getByRole('tablist', { name: 'Conversations' })
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: 'Conversation', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  expect(created).toBe(0)
  const question = page.getByRole('textbox', { name: 'Your question' })
  await question.fill('Explain Python scopes')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.locator('.learning-chat-history-row')).toHaveCount(2)
  await page.getByRole('button', { name: /^How does bytecode work\?/ }).click()
  await expect(question).toHaveValue('')
  await tabs.getByRole('tab', { name: 'New chat', exact: true }).click()
  await expect(question).toHaveValue('Explain Python scopes')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('A deterministic test answer.')).toBeVisible()
  expect(created).toBe(1)
  await page.getByRole('button', { name: 'Close tab: Explain Python scopes', exact: true }).click()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.locator('.learning-chat-history-row')).toHaveCount(3)
  await shot(page, 'reading-chat-history')
  await page.getByRole('button', { name: /^Explain Python scopes/ }).click()
  await expect(page.getByText('A deterministic test answer.')).toBeVisible()
  const selectedTab = tabs.getByRole('tab', { name: 'Explain Python scopes', exact: true })
  await expect(selectedTab).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => {
    const tab = (await selectedTab.boundingBox())!, strip = (await tabs.boundingBox())!
    return tab.x >= strip.x - 1 && tab.x + tab.width <= strip.x + strip.width + 1
  }).toBe(true)
  await shot(page, 'reading-chat-tabs')
  await page.reload()
  await page.getByRole('button', { name: 'Open reading chat' }).click()
  await expect(page.getByText('A deterministic test answer.')).toBeVisible()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Delete chat: Explain Python scopes', exact: true }).click()
  await expect(page.locator('.learning-chat-history-row')).toHaveCount(2)
  await expect(tabs.getByRole('tab', { name: 'Explain Python scopes', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await shot(page, 'reading-chat-history-mobile')
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  expect(errors).toEqual([])
})
