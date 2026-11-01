// @vitest-environment node
import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ user: 'learner', windows: [] as any[], reply: undefined as any }))
vi.mock('electron', () => ({ ipcMain: { on: (_channel: string, handler: unknown) => { state.reply = handler } } }))
vi.mock('../src/main/users', () => ({ currentUserId: () => state.user, requireUser: () => state.user }))
vi.mock('../src/main/writing-notebook-windows', () => ({ coachContextWindows: () => state.windows }))
const { registerCoachContextIpc, readAppContext, readOpenNotebook } = await import('../src/main/coach-context')
function window(id: number, focused = false) {
  const webContents = Object.assign(new EventEmitter(), { id, send: vi.fn() })
  return { webContents, isFocused: () => focused, isMinimized: () => false }
}
beforeEach(() => { vi.useFakeTimers(); state.user = 'learner'; state.windows = []; registerCoachContextIpc() })
afterEach(() => { vi.useRealTimers() })
it('queries focused app windows first and correlates replies to the exact sender and request', async () => {
  const main = window(1), notes = window(2, true); state.windows = [main, notes]
  const pending = readAppContext(0)
  expect(main.webContents.send).not.toHaveBeenCalled()
  const request = notes.webContents.send.mock.calls[0]![1]
  let done = false; void pending.then(() => { done = true })
  state.reply({ sender: { id: 1 } }, request.requestId, { entries: [] })
  await Promise.resolve(); expect(done).toBe(false)
  state.reply({ sender: { id: 2 } }, request.requestId, { entries: [{ kind: 'writing-notebook', selectedText: 'live text' }] })
  expect(await pending).toMatchObject({ windows: [{ focused: true, entries: [{ selectedText: 'live text' }] }], nextCursor: 1 })
  const next = readAppContext(1), nextRequest = main.webContents.send.mock.calls[0]![1]
  state.reply({ sender: { id: 1 } }, nextRequest.requestId, { entries: [{ kind: 'lesson' }] })
  expect(await next).toMatchObject({ nextCursor: null })
})
it('reports timeouts and closed windows, and never substitutes saved text for an unresponsive open editor', async () => {
  const notes = window(2); state.windows = [notes]
  const pending = readOpenNotebook('read_notebook_page', { notebook_id: 'n', page_id: 'p', offset: 0 })
  const rejected = expect(pending).rejects.toThrow('did not respond')
  await vi.advanceTimersByTimeAsync(2500); await rejected
  const context = readAppContext(0)
  notes.webContents.emit('destroyed')
  expect(await context).toMatchObject({ windows: [{ error: 'This window closed or reloaded.' }] })
  expect(notes.webContents.listenerCount('destroyed')).toBe(0)
})
it('rejects a context response if the learner changes while the renderer is replying', async () => {
  const main = window(1); state.windows = [main]
  const pending = readAppContext(0), request = main.webContents.send.mock.calls[0]![1]
  state.user = 'other'
  state.reply({ sender: { id: 1 } }, request.requestId, { entries: [{ selectedText: 'private' }] })
  await expect(pending).rejects.toThrow('learner changed')
})
