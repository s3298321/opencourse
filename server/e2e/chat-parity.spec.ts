import { test, expect } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('reading chat matches app citations, activity, quotes and composer choices', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let settings = { configured: true, enabled: true, hint: 'test', model: 'gpt-5.1', reasoning: 'low', title: null, webSearch: true, enabledModels: ['gpt-5.1', 'gpt-4.1-mini'] }
  await page.route('**/api/v1/me/ai', async route => {
    if (route.request().method() === 'PUT') settings = { ...settings, ...route.request().postDataJSON() }
    await route.fulfill({ json: settings })
  })
  await page.route('**/api/v1/me/ai/models', route => route.fulfill({ json: { source: 'api', models: ['gpt-5.1', 'gpt-4.1-mini', 'gpt-5-mini'].map(id => ({ id, label: id })) } }))
  await page.goto('/signin')
  await page.getByLabel('Email or username').fill('lin')
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: /lin/ })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: /The OpenCourse example course/ }).click()
  await page.getByRole('button', { name: 'Add to library' }).click()
  await page.getByRole('link', { name: 'Start course', exact: true }).click()
  const contentId = new URL(page.url()).pathname.split('/').at(-1)!
  const chat = { id: 'fixture-chat', kind: 'course', contentId, version: '1.0.0', title: 'Understanding functions', createdAt: new Date().toISOString(), messages: 2, running: true }
  const messages: any[] = [
    { id: 'q', chatId: chat.id, role: 'user', text: 'Explain this passage', quote: 'A function lets you reuse a piece of code.', status: 'complete', at: chat.createdAt, citations: [] },
    { id: 'a', chatId: chat.id, role: 'assistant', text: '', status: 'running', at: chat.createdAt, citations: [], activity: { label: 'Searching the web', running: true } }
  ]
  let sent: any
  await page.route('**/api/v1/learning/chats**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' })
    if (url.pathname.endsWith('/messages')) {
      sent = route.request().postDataJSON()
      return route.fulfill({ json: { messageId: 'next' } })
    }
    if (url.search) return route.fulfill({ json: { chats: [chat] } })
    return route.fulfill({ json: { chat, messages } })
  })
  await page.getByRole('button', { name: 'Open reading chat' }).click()
  const panel = page.getByRole('complementary', { name: 'Reading chat' })
  await expect(panel.locator('blockquote.chat-quote')).toHaveText('A function lets you reuse a piece of code.')
  await expect(panel.getByRole('status', { name: 'Thinking' })).toBeVisible()
  await expect(panel.locator('.chat-typing i').first()).toHaveCSS('animation-duration', '1.2s')
  await expect(panel.locator('.project-tool-activity')).toHaveCSS('animation-duration', '1.4s')
  await expect(panel.getByRole('img', { name: 'OpenAI API key' })).toBeVisible()
  await page.screenshot({ path: join(tmpdir(), 'opencourse-web-chat-thinking.png') })
  messages[1] = { ...messages[1], status: 'complete', text: 'Functions make programs easier to maintain. [Python documentation](https://docs.python.org/3/tutorial/controlflow.html)', citations: [{ title: 'Python documentation', url: 'https://docs.python.org/3/tutorial/controlflow.html' }] }
  chat.running = false
  await expect(panel.locator('sup.cite a')).toHaveText('1')
  await expect(panel.getByRole('navigation', { name: 'Cited sources' }).locator('li')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Reasoning for this chat' }).click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Reasoning for this chat' })).toContainText('High')
  await panel.getByRole('button', { name: 'Model for this chat' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'gpt-5-mini', exact: true })).toHaveCount(0)
  await page.getByRole('menuitemradio', { name: 'gpt-4.1-mini', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Reasoning for this chat' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Model for this chat' }).click()
  await page.getByRole('menuitemradio', { name: 'gpt-5.1', exact: true }).click()
  await panel.getByRole('button', { name: 'Reasoning for this chat' }).click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Your question' }).fill('Give an example')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => sent).toMatchObject({ text: 'Give an example', model: 'gpt-5.1', reasoning: 'high' })
  await page.screenshot({ path: join(tmpdir(), 'opencourse-web-chat-citations.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: 'Model for this chat' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('animation-name', 'none')
  await expect(menu).toHaveCSS('background-color', /^(rgb\(0, 0, 0\)|color\(srgb 0 0 0\))$/)
  const box = (await menu.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(tmpdir(), 'opencourse-web-chat-mobile.png') })
  await page.keyboard.press('Escape')
  await page.goto('/settings')
  const allowed = page.getByRole('group', { name: 'Allowed chat models' })
  await expect(allowed.getByLabel('gpt-5-mini', { exact: true })).not.toBeChecked()
  await allowed.getByLabel('gpt-5-mini', { exact: true }).check()
  await allowed.getByLabel('gpt-5.1', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save AI settings' }).click()
  await expect.poll(() => settings.enabledModels).toEqual(['gpt-4.1-mini', 'gpt-5-mini'])
  expect(settings.model).toBe('gpt-4.1-mini')
  expect(errors).toEqual([])
})
