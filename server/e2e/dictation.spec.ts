import { test, expect } from '@playwright/test'
import { answerDictationOffer } from '../../app/tests/helpers/dictation-peer'

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream'] },
  ignoreHTTPSErrors: true, reducedMotion: 'reduce' })

test('reading chat streams into the draft, finalizes on Stop, and sends only on request', async ({ page }) => {
  await page.route('**/api/v1/me/ai', route => route.fulfill({ json: { enabled: true, configured: true,
    model: 'gpt-5.1', reasoning: null, transcription: { connection: 'apiKey', model: 'gpt-live-transcribe' } } }))
  await page.route('**/api/v1/me/ai/models', route => route.fulfill({ json: { models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }] } }))
  await page.route('**/api/v1/me/ai/transcription/session', async route => {
    const { sdp, account } = route.request().postDataJSON()
    expect(account).toBeTruthy()
    const answerSdp = await page.evaluate(answerDictationOffer, sdp)
    await route.fulfill({ json: { answerSdp } })
  })
  let sends = 0
  page.on('request', request => { if (request.url().endsWith('/messages') && request.method() === 'POST') sends++ })
  await page.goto((process.env.OPENCOURSE_DICTATION_HTTPS_URL ?? '') + '/signin')
  await page.getByLabel('Email or username').fill('kit')
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: /kit/ })).toBeVisible()
  await page.getByRole('link', { name: /The OpenCourse example course/ }).first().click()
  const add = page.getByRole('button', { name: 'Add to library' })
  const start = page.getByRole('link', { name: 'Start course', exact: true })
  await expect(add.or(start)).toBeVisible()
  if (await add.isVisible()) await add.click()
  await start.click()
  await page.getByRole('button', { name: 'Open reading chat' }).click()
  await page.getByRole('button', { name: 'Start dictation' }).click()
  const input = page.getByRole('textbox', { name: 'Your question' })
  await expect(input).toHaveValue('Check my draft')
  await expect(input).toHaveAttribute('readonly', '')
  expect(await input.evaluate(el => getComputedStyle(el.closest('[data-dictation]')!, '::after').animationName)).toBe('none')
  await input.press('Enter')
  await input.press('Home')
  await page.getByRole('button', { name: 'Stop dictation' }).click()
  await expect(input).toHaveValue('Check my draft.')
  await expect(input).toBeEditable()
  await expect(input).toBeFocused()
  await page.keyboard.type(' Next')
  await expect(input).toHaveValue('Check my draft. Next')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(sends).toBe(0)

  // Closing the drawer while the connection is live keeps its draft and releases capture.
  await input.fill('')
  await page.getByRole('button', { name: 'Start dictation' }).click()
  await expect(input).toHaveValue('Check my draft')
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await page.getByRole('button', { name: 'Open reading chat' }).click()
  await expect(input).toBeEditable()
  await expect(input).toHaveValue('Check my draft')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
  expect(sends).toBe(0)
})
