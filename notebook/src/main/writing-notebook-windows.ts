import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { isStandaloneNotebook } from '../core/writing-notebooks/standalone'
import { currentUserId, requireUser } from './users'
import { getWritingNotebook, touchWritingNotebook, updateWritingNotebook, writingNotebookEvents } from './writing-notebooks'
import { pruneNotebookSketches } from './writing-notebook-sketch'
import type { ReadingSource } from '../core/documents/types'
interface Entry { window: BrowserWindow; owner: string; notebookId: string; closing: boolean; ready: boolean; preparing?: boolean; page?: string; flushes: string[] }
const windows = new Map<number, Entry>()
let factory: (notebookId?: string) => BrowserWindow
let mainWindow: BrowserWindow | undefined
let mainReady = false
const mainMessages: { channel: string; payload: unknown; owner: string | null }[] = []
const pending = new Map<string, { sender: number; resolve: (ok: boolean) => void }>()
export function configureNotebookWindows(create: typeof factory): void { factory = create }
function releaseWindow(id: number): void {
  const entry = windows.get(id)
  windows.delete(id)
  for (const [, request] of pending) if (request.sender === id) request.resolve(true)
  // The editor and its undo history are gone; unreferenced sketch versions can go too.
  if (entry && entry.owner === currentUserId()) { try { pruneNotebookSketches(entry.notebookId) } catch { /* Deleted notebook; cleanup is best-effort. */ } }
}
export function registerMainWindow(window: BrowserWindow): void {
  mainWindow = window
  mainReady = false
  window.webContents.on('did-start-navigation', event => {
    if (!event.isMainFrame || event.isSameDocument) return
    mainReady = false
    releaseWindow(window.webContents.id)
  })
  window.once('closed', () => { releaseWindow(window.webContents.id); if (mainWindow === window) mainWindow = undefined })
}
export function focusMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = factory()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus(); return mainWindow
}
export function sendToMainWindow(channel: string, payload: unknown): void {
  const window = focusMainWindow()
  if (mainReady) window.webContents.send(channel, payload)
  else mainMessages.push({ channel, payload, owner: currentUserId() })
}
export function notebookWindowIdentity(sender: WebContents): Entry | undefined { return windows.get(sender.id) }
export function assertNotebookWindow(sender: WebContents, notebookId?: string): void {
  const entry = windows.get(sender.id)
  if (!entry) return
  if (entry.owner !== requireUser()) throw new Error('This notebook window no longer belongs to the selected user or notebook.')
  // The notebook app's one window switches notebooks in place. Only a separate
  // window is pinned to the notebook it was opened on.
  if (entry.window !== mainWindow && notebookId !== undefined && entry.notebookId !== notebookId) throw new Error('This notebook window no longer belongs to the selected user or notebook.')
}
function flushWindow(entry: Entry): Promise<boolean> {
  if (entry.window.isDestroyed()) return Promise.resolve(true)
  return new Promise(resolve => {
    const id = randomUUID(), timeout = setTimeout(() => { pending.delete(id); resolve(false) }, 15_000)
    pending.set(id, { sender: entry.window.webContents.id, resolve: ok => { clearTimeout(timeout); pending.delete(id); resolve(ok) } })
    if (entry.ready) entry.window.webContents.send('writing:flush', id)
    else entry.flushes.push(id)
  })
}
export async function closeWritingWindows(): Promise<void> {
  const entries = [...windows.values()]
  for (const entry of entries) if (!await flushWindow(entry)) {
    if (!entry.window.isDestroyed()) entry.window.webContents.send('writing:resume')
    entry.window.focus()
    throw new Error('Save the notebook changes before changing users or quitting.')
  }
}
export async function openWritingNotebook(id: string, pageId?: string): Promise<void> {
  const notebook = getWritingNotebook(id)
  requireUser()
  if (!isStandaloneNotebook(notebook)) throw new Error('This notebook is linked to OpenCourse content and stays in OpenCourse.')
  if (pageId && !notebook.pages.some(p => p.id === pageId)) throw new Error('This notebook page no longer exists.')
  if (pageId) updateWritingNotebook(id, { selectedPageId: pageId })
  try { pruneNotebookSketches(id) } catch { /* Cleanup is best-effort. */ }
  touchWritingNotebook(id)
  const window = focusMainWindow()
  window.webContents.send('writing:openNotebook', id, pageId)
}
export function registerWritingWindowIpc(): void {
  ipcMain.on('writing:mainReady', event => {
    if (mainWindow?.webContents.id !== event.sender.id) return
    mainReady = true
    for (const message of mainMessages.splice(0)) if (message.owner === currentUserId()) event.sender.send(message.channel, message.payload)
  })
  ipcMain.on('writing:idle', event => { if (mainWindow?.webContents.id === event.sender.id) releaseWindow(event.sender.id) })
  ipcMain.on('writing:ready', (event, notebookId: unknown) => {
    const owner = currentUserId()
    if (!owner || typeof notebookId !== 'string') return
    if (mainWindow?.webContents.id === event.sender.id) {
      const previous = windows.get(event.sender.id)
      // Switching notebooks in place leaves the old editor behind; clean its sketches.
      if (previous && previous.owner === owner && previous.notebookId !== notebookId) { try { pruneNotebookSketches(previous.notebookId) } catch { /* Cleanup is best-effort. */ } }
      const entry = previous ?? { window: mainWindow, owner, notebookId, closing: false, ready: false, flushes: [] }
      entry.owner = owner
      entry.notebookId = notebookId
      entry.ready = true
      windows.set(event.sender.id, entry)
      for (const id of entry.flushes.splice(0)) if (pending.has(id)) event.sender.send('writing:flush', id)
      return
    }
    const entry = windows.get(event.sender.id)
    if (!entry || entry.owner !== owner) return
    entry.ready = true
    if (entry.page) { event.sender.send('writing:selectPage', entry.page); entry.page = undefined }
    for (const id of entry.flushes.splice(0)) if (pending.has(id)) event.sender.send('writing:flush', id)
  })
  ipcMain.on('writing:flushed', (event, id: string, ok: boolean) => { const request = pending.get(id); if (request?.sender === event.sender.id) request.resolve(ok === true) })
  ipcMain.handle('writing:settings', event => { assertNotebookWindow(event.sender); sendToMainWindow('app:navigate', 'settings') })
  ipcMain.handle('writing:source', (event, source: ReadingSource) => {
    assertNotebookWindow(event.sender)
    if (source.kind !== 'writing-notebook') throw new Error('OpenCourse Notebook only opens notebook pages.')
    return openWritingNotebook(source.notebookId, source.pageId)
  })
  writingNotebookEvents.on('changed', id => { for (const entry of windows.values()) if (entry.notebookId === id && entry.owner === currentUserId() && !entry.window.isDestroyed()) { try { entry.window.setTitle(getWritingNotebook(id).title) } catch { /* Deleted. */ } } })
  writingNotebookEvents.on('removing', id => { for (const entry of windows.values()) if (entry.window !== mainWindow && entry.notebookId === id && entry.owner === currentUserId()) { entry.closing = true; entry.window.destroy() } })
}

/** Only app-owned windows for the current learner; never devtools or other users. */
export function coachContextWindows(owner: string, target?: string): BrowserWindow[] {
  const result: BrowserWindow[] = []
  if ((!target || target === 'main') && mainWindow && !mainWindow.isDestroyed()) result.push(mainWindow)
  if (target !== 'main') for (const entry of windows.values()) {
    if (entry.owner === owner && !entry.closing && !entry.window.isDestroyed() && (!target || target === entry.notebookId)) result.push(entry.window)
  }
  return result
}
