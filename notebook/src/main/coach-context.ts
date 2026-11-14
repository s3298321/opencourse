import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { CoachContextReply, CoachContextRequest } from '../core/coach/context'
import { currentUserId, requireUser } from './users'
import { coachContextWindows } from './writing-notebook-windows'
import { whenSenderGone } from './senders'

const pending = new Map<string, { senderId: number; owner: string; finish: (reply: CoachContextReply) => void }>()
export function registerCoachContextIpc(): void {
  ipcMain.on('coach:contextReply', (event, id: string, value: CoachContextReply) => {
    const request = pending.get(id)
    if (!request || request.senderId !== event.sender.id) return
    if (request.owner !== currentUserId()) { request.finish({ error: 'The learner changed.' }); return }
    try {
      if (!value || typeof value !== 'object' || JSON.stringify(value).length > 32_000) throw new Error('Invalid context')
      request.finish(value)
    } catch { request.finish({ error: 'The app context exceeded its size limit or was invalid.' }) }
  })
}
function requestWindow(window: BrowserWindow, tool: CoachContextRequest['tool'], args: Record<string, unknown>): Promise<CoachContextReply> {
  const owner = requireUser(), requestId = randomUUID()
  return new Promise(resolve => {
    const finish = (reply: CoachContextReply) => { clearTimeout(timeout); unwatch(); pending.delete(requestId); resolve(reply) }
    const timeout = setTimeout(() => finish({ error: 'This window did not respond. Its current context is unavailable.' }), 2500)
    const unwatch = whenSenderGone(window.webContents, () => finish({ error: 'This window closed or reloaded.' }))
    pending.set(requestId, { senderId: window.webContents.id, owner, finish })
    try { window.webContents.send('coach:contextRequest', { requestId, userId: owner, tool, args } satisfies CoachContextRequest) }
    catch { finish({ error: 'This window is unavailable.' }) }
  })
}
export async function readAppContext(cursor: number): Promise<unknown> {
  const owner = requireUser(), windows = coachContextWindows(owner).sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()))
  // One window per page bounds even many open notebook windows and long selections.
  const window = windows[cursor]
  if (!window) return { windows: [], nextCursor: null }
  const focused = window.isFocused(), minimized = window.isMinimized()
  const result = await requestWindow(window, 'get_app_context', {})
  if (owner !== currentUserId()) throw new Error('The learner changed.')
  return { capturedAt: new Date().toISOString(), windows: [{ focused, minimized, ...result }], nextCursor: cursor + 1 < windows.length ? cursor + 1 : null }
}
export async function readOpenNotebook(tool: 'read_notebook_page' | 'read_notebook_cells', args: Record<string, unknown>): Promise<unknown | undefined> {
  const owner = requireUser()
  const windows = coachContextWindows(owner, tool === 'read_notebook_page' ? String(args.notebook_id) : 'main')
  for (const window of windows) {
    const reply = await requestWindow(window, tool, args)
    if (owner !== currentUserId()) throw new Error('The learner changed.')
    if (reply.error) throw new Error(reply.error)
    if (reply.value !== undefined) return reply.value
  }
  return undefined
}
