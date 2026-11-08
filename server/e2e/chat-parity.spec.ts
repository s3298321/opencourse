import { test, expect } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('reading chat matches app citations, activity, quotes and composer choices', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let settings = { configured: true, enabled: true, hint: 'test', model: 'gpt-5.1', reasoning: 'low', title: null, webSearch: true, perChatTools: true, enabledModels: ['gpt-5.1', 'gpt-4.1-mini'] }
  await page.route('**/api/v1/me/ai', async route => {
    if (route.request().method() === 'PUT') settings = { ...settings, ...route.request().postDataJSON() }
    await route.fulfill({ json: settings })
  })
  await page.route('**/api/v1/me/ai/models', route => route.fulfill({ json: { source: 'api', models: ['gpt-5.1', 'gpt-4.1-mini', 'gpt-5-mini'].map(id => ({ id, label: id })) } }))
  await page.goto('/signin')
  await page.getByLabel('Email or username').fill('kit')
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: /kit/ })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: /The OpenCourse example course/ }).click()
  await page.getByRole('button', { name: 'Add to library' }).click()
  await page.getByRole('link', { name: 'Start course', exact: true }).click()
  const contentId = new URL(page.url()).pathname.split('/').at(-1)!
  const chat = { id: 'fixture-chat', tools: { webSearch: true }, kind: 'course', contentId, version: '1.0.0', title: 'Understanding functions', createdAt: new Date().toISOString(), messages: 2, running: true }
  const messages: any[] = [
    { id: 'q', chatId: chat.id, role: 'user', text: 'Explain this passage', quote: 'A function lets you reuse a piece of code.', status: 'complete', at: chat.createdAt, citations: [] },
    { id: 'a', chatId: chat.id, role: 'assistant', text: '', status: 'running', at: chat.createdAt, citations: [], activity: { label: 'Searching the web', running: true } }
  ]
  let disconnectRead = false
  let sent: any
  await page.route('**/api/v1/learning/chats**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' })
    if (url.pathname.endsWith('/messages')) {
      sent = route.request().postDataJSON()
      return route.fulfill({ json: { messageId: 'next' } })
    }
    if (url.pathname.endsWith('/tools')) { chat.tools = route.request().postDataJSON(); return route.fulfill({ json: { chat, messages } }) }
    if (url.search) return route.fulfill({ json: { chats: [chat] } })
    if (disconnectRead) return route.abort('internetdisconnected')
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
  const warning = panel.locator('.chat-network-warning')
  messages[1].retryAttempt = 2
  await expect(warning).toHaveText('Connection interrupted. Reconnecting (retry 2 of 5)…')
  delete messages[1].retryAttempt
  await expect(warning).toHaveCount(0)
  disconnectRead = true
  await expect(warning).toHaveText('Connection interrupted. Reconnecting (retry 1 of 5)…')
  disconnectRead = false
  await expect(warning).toHaveCount(0)
  messages[1].text = String.raw`Evaluate \(f(x)\) at two.`
  await expect(panel.locator('.learning-message.assistant .course-inline-formula annotation')).toHaveText('f(x)')
  messages[1] = { ...messages[1], status: 'complete', text: 'For $f(x)$, the result is\n\n$$f(2) = 4$$\n\n' + 'A function can take parameters and return a value.\n\n'.repeat(30) + 'Functions make programs easier to maintain. [Python documentation](https://docs.python.org/3/tutorial/controlflow.html)', citations: [{ title: 'Python documentation', url: 'https://docs.python.org/3/tutorial/controlflow.html' }] }
  chat.running = false
  await expect(panel.locator('.learning-message.assistant math[display="block"] annotation')).toHaveText('f(2) = 4')
  await expect(panel.locator('sup.cite a')).toHaveText('1')
  await expect(panel.getByRole('navigation', { name: 'Cited sources' }).locator('li')).toHaveCount(1)
  const transcript = panel.locator('.learning-messages')
  await transcript.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 60 })
  const readingPosition = () => transcript.evaluate(el => [el.scrollTop, el.clientHeight, el.firstElementChild!.getBoundingClientRect().top])
  const beforeHistory = await readingPosition()
  expect(beforeHistory[0]).toBeGreaterThan(0)
  const historyToggle = panel.getByRole('button', { name: 'History', exact: true })
  await historyToggle.click()
  await expect(panel.locator('.learning-chat-history')).toBeVisible()
  expect(await readingPosition()).toEqual(beforeHistory)
  await historyToggle.click()
  await expect(panel.locator('.learning-chat-history')).toHaveCount(0)
  expect(await readingPosition()).toEqual(beforeHistory)

  await panel.getByRole('button', { name: 'Chat tools: Web search' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: /Plan/ })).toHaveCount(0)
  const toolState = () => page.getByRole('menuitemcheckbox', { name: /Web search/ })
    .evaluate(row => row.ownerDocument.defaultView!.getComputedStyle(row, '::after').content)
  await expect.poll(toolState).toContain('On')
  await page.getByRole('menuitemcheckbox', { name: /Web search/ }).click()
  await expect(panel.getByRole('button', { name: 'Chat tools: none enabled' })).toBeVisible()
  const webOption = page.getByRole('menuitemcheckbox', { name: /Web search/ })
  await expect(webOption).toBeVisible()
  await expect(webOption).not.toBeChecked()
  await expect.poll(toolState).toContain('Off')
  await expect(webOption.locator('.menu-item-icon svg')).toBeVisible()
  await webOption.click()
  await expect(webOption).toBeChecked()
  await expect(panel.getByRole('img', { name: 'Active tools: Web search' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(webOption).toHaveCount(0)
  await panel.getByRole('button', { name: 'Reasoning for this chat' }).click()
  const selectedReasoning = page.getByRole('menuitemradio', { checked: true })
  await expect.poll(() => selectedReasoning.evaluate(row => row.ownerDocument.defaultView!.getComputedStyle(row, '::after').maskImage)).not.toBe('none')
  await expect(page.getByRole('menuitemradio').nth(1)).toHaveCSS('margin-block-start', '4px')
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
  const toolsRow = panel.locator('.chat-tools-row')
  await expect(toolsRow.locator('.chat-tool-name')).toHaveText('Web search')
  await page.setViewportSize({ width: 280, height: 844 })
  await expect(toolsRow.locator('.chat-tools-count')).toHaveText('…+1')
  await expect(toolsRow.locator(':scope > svg')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(toolsRow.locator('.chat-tool-name')).toHaveText('Web search')
  await expect(toolsRow.locator('.chat-tools-count')).toHaveCount(0)
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
